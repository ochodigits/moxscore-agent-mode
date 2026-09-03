-- Billing operations: independent webhook claim semantics, bounded/resumable
-- reconciliation, aggregate health signals, and fail-closed drift blocking.
--
-- This migration is additive. It is intended for the isolated paid Preview
-- project only until a separately approved Production billing release.

alter table public.billing_customers
  add column if not exists reconciliation_key bigint generated always as identity;

alter table public.billing_customers
  add column if not exists reconciliation_blocked boolean not null default false;

create unique index if not exists billing_customers_reconciliation_key_idx
  on public.billing_customers (reconciliation_key);

alter table public.subscriptions
  add column if not exists reconciliation_blocked boolean not null default false;

alter table public.subscriptions
  add column if not exists last_reconciled_at timestamptz;

create index if not exists subscriptions_owner_blocked_idx
  on public.subscriptions (owner_id, reconciliation_blocked);

create index if not exists webhook_events_failed_idx
  on public.webhook_events (processed_at)
  where result = 'failed';

-- A boolean primary key makes this an explicit singleton without relying on a
-- magic integer. It stores only cursors, aggregate reports, and timestamps.
create table if not exists public.billing_reconciliation_state (
  singleton boolean primary key default true check (singleton),
  active_run_id text,
  lease_expires_at timestamptz,
  next_customer_key bigint not null default 0 check (next_customer_key >= 0),
  last_attempt_at timestamptz,
  last_page_success_at timestamptz,
  last_full_success_at timestamptz,
  last_failure_at timestamptz,
  last_status text check (last_status in ('succeeded', 'failed', 'skipped_overlap')),
  cycle_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(cycle_counts) = 'object'),
  last_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(last_counts) = 'object'),
  updated_at timestamptz not null default now()
);

insert into public.billing_reconciliation_state (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.billing_reconciliation_runs (
  run_id text primary key check (char_length(btrim(run_id)) between 16 and 100),
  mode text not null check (mode in ('dry_run', 'repair')),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  cursor_from bigint not null check (cursor_from >= 0),
  cursor_to bigint check (cursor_to is null or cursor_to >= 0),
  has_more boolean,
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists billing_reconciliation_runs_started_idx
  on public.billing_reconciliation_runs (started_at desc);

alter table public.billing_reconciliation_state enable row level security;
alter table public.billing_reconciliation_runs enable row level security;

revoke all privileges on table public.billing_reconciliation_state from public, anon, authenticated;
revoke all privileges on table public.billing_reconciliation_runs from public, anon, authenticated;
revoke all privileges on table public.billing_reconciliation_state from service_role;
revoke all privileges on table public.billing_reconciliation_runs from service_role;
grant select on public.billing_reconciliation_state to service_role;
grant select on public.billing_reconciliation_runs to service_role;

-- Unlike the earlier boolean claim function, this distinguishes a completed
-- duplicate from a live/abandoned attempt. A valid redelivery that arrives
-- while a lease is live receives a retryable response instead of a false 2xx.
create or replace function public.moxscore_claim_webhook_event(
  p_event_id text,
  p_event_type text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed_at timestamptz;
  v_result text;
  v_received_at timestamptz;
begin
  if p_event_id is null
    or char_length(btrim(coalesce(p_event_id, ''))) not between 1 and 255
    or char_length(btrim(coalesce(p_event_type, ''))) not between 1 and 100 then
    raise exception 'Invalid webhook event' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_event_id)));

  insert into public.webhook_events (provider_event_id, event_type)
  values (btrim(p_event_id), btrim(p_event_type))
  on conflict (provider_event_id) do nothing;

  if found then
    return 'claimed';
  end if;

  select processed_at, result, received_at
    into v_processed_at, v_result, v_received_at
  from public.webhook_events
  where provider_event_id = btrim(p_event_id);

  if v_processed_at is not null and v_result in ('processed', 'ignored') then
    return 'duplicate_processed';
  end if;

  if v_result = 'failed' or v_received_at < now() - interval '5 minutes' then
    update public.webhook_events
    set received_at = now(), processed_at = null, result = null
    where provider_event_id = btrim(p_event_id);
    return 'claimed';
  end if;

  return 'retry_later';
end;
$$;

-- Acquires a short durable lease and returns the keyset cursor. The row lock is
-- released before the caller performs any Stripe request.
create or replace function public.moxscore_start_billing_reconciliation(
  p_run_id text,
  p_mode text,
  p_lease_seconds integer
)
returns table (acquired boolean, start_cursor bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.billing_reconciliation_state%rowtype;
begin
  if char_length(btrim(coalesce(p_run_id, ''))) not between 16 and 100
    or p_mode not in ('dry_run', 'repair')
    or p_lease_seconds not between 30 and 900 then
    raise exception 'Invalid reconciliation request' using errcode = '22023';
  end if;

  select * into v_state
  from public.billing_reconciliation_state
  where singleton = true
  for update;

  if v_state.active_run_id is not null and v_state.lease_expires_at > now() then
    return query select false, v_state.next_customer_key;
    return;
  end if;

  insert into public.billing_reconciliation_runs (run_id, mode, status, cursor_from)
  values (btrim(p_run_id), p_mode, 'running', v_state.next_customer_key);

  update public.billing_reconciliation_state
  set active_run_id = btrim(p_run_id),
      lease_expires_at = now() + pg_catalog.make_interval(secs => p_lease_seconds),
      last_attempt_at = now(),
      updated_at = now()
  where singleton = true;

  return query select true, v_state.next_customer_key;
end;
$$;

create or replace function public.moxscore_finish_billing_reconciliation(
  p_run_id text,
  p_status text,
  p_next_cursor bigint,
  p_has_more boolean,
  p_counts jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_run text;
  v_cycle_counts jsonb;
begin
  if p_status not in ('succeeded', 'failed')
    or p_next_cursor is null or p_next_cursor < 0
    or p_has_more is null
    or p_counts is null or jsonb_typeof(p_counts) <> 'object'
    or exists (
      select 1 from jsonb_each(p_counts)
      where jsonb_typeof(value) <> 'number'
    ) then
    raise exception 'Invalid reconciliation result' using errcode = '22023';
  end if;

  select active_run_id, cycle_counts into v_active_run, v_cycle_counts
  from public.billing_reconciliation_state
  where singleton = true
  for update;

  if v_active_run is distinct from btrim(p_run_id) then
    raise exception 'Reconciliation lease mismatch' using errcode = '55000';
  end if;

  select coalesce(jsonb_object_agg(key, total), '{}'::jsonb)
    into v_cycle_counts
  from (
    select key, sum((value #>> '{}')::numeric) as total
    from (
      select key, value from jsonb_each(coalesce(v_cycle_counts, '{}'::jsonb))
      union all
      select key, value from jsonb_each(p_counts)
    ) entries
    group by key
  ) totals;

  update public.billing_reconciliation_runs
  set status = p_status,
      cursor_to = p_next_cursor,
      has_more = p_has_more,
      counts = p_counts,
      completed_at = now()
  where run_id = btrim(p_run_id);

  update public.billing_reconciliation_state
  set active_run_id = null,
      lease_expires_at = null,
      next_customer_key = case when p_status = 'succeeded' and p_has_more then p_next_cursor else 0 end,
      last_page_success_at = case when p_status = 'succeeded' then now() else last_page_success_at end,
      last_full_success_at = case when p_status = 'succeeded' and not p_has_more then now() else last_full_success_at end,
      last_failure_at = case when p_status = 'failed' then now() else last_failure_at end,
      last_status = p_status,
      cycle_counts = case when p_status = 'succeeded' and p_has_more then v_cycle_counts else '{}'::jsonb end,
      last_counts = v_cycle_counts,
      updated_at = now()
  where singleton = true;
end;
$$;

-- Signed webhooks use this customer-aware overload. Ownership is checked
-- again inside the same short transaction that writes the projection, closing
-- the lookup/write race in the application layer. The legacy overload is
-- retained for migration compatibility but is no longer executable by the
-- service role.
create or replace function public.moxscore_project_subscription(
  p_subscription_id text,
  p_customer_id text,
  p_owner_id uuid,
  p_price_key text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_event_at timestamptz;
  v_existing_owner uuid;
  v_mapping_owner uuid;
  v_mapping_blocked boolean;
begin
  if char_length(btrim(coalesce(p_subscription_id, ''))) not between 1 and 255
    or char_length(btrim(coalesce(p_customer_id, ''))) not between 1 and 255
    or p_owner_id is null
    or char_length(btrim(coalesce(p_price_key, ''))) not between 1 and 100
    or p_status not in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled')
    or p_event_at is null then
    raise exception 'Invalid subscription projection' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_subscription_id)));

  select owner_id, reconciliation_blocked into v_mapping_owner, v_mapping_blocked
  from public.billing_customers
  where provider_customer_id = btrim(p_customer_id);

  if v_mapping_owner is distinct from p_owner_id then
    raise exception 'Billing ownership mismatch' using errcode = '55000';
  end if;

  select owner_id, last_event_at into v_existing_owner, v_existing_event_at
  from public.subscriptions
  where provider_subscription_id = btrim(p_subscription_id);

  if v_existing_owner is not null and v_existing_owner is distinct from p_owner_id then
    raise exception 'Subscription ownership mismatch' using errcode = '55000';
  end if;
  if v_existing_event_at is not null and v_existing_event_at > p_event_at then
    return false;
  end if;

  insert into public.subscriptions (
    provider_subscription_id, owner_id, price_key, status,
    current_period_end, cancel_at_period_end, last_event_at,
    reconciliation_blocked
  ) values (
    btrim(p_subscription_id), p_owner_id, btrim(p_price_key), p_status,
    p_current_period_end, coalesce(p_cancel_at_period_end, false), p_event_at,
    v_mapping_blocked
  )
  on conflict (provider_subscription_id) do update set
    price_key = excluded.price_key,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_event_at = excluded.last_event_at;

  return true;
end;
$$;

-- Writes only provider-authoritative state for an existing server-owned
-- customer mapping. A newer signed event wins if it raced this provider read.
create or replace function public.moxscore_reconcile_subscription(
  p_subscription_id text,
  p_customer_id text,
  p_owner_id uuid,
  p_price_key text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_observed_at timestamptz,
  p_reconciliation_blocked boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_event_at timestamptz;
  v_existing_owner uuid;
  v_mapping_owner uuid;
  v_mapping_blocked boolean;
begin
  if char_length(btrim(coalesce(p_subscription_id, ''))) not between 1 and 255
    or char_length(btrim(coalesce(p_customer_id, ''))) not between 1 and 255
    or p_owner_id is null
    or char_length(btrim(coalesce(p_price_key, ''))) not between 1 and 100
    or p_status not in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled')
    or p_observed_at is null or p_reconciliation_blocked is null then
    raise exception 'Invalid reconciliation projection' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_subscription_id)));

  select owner_id, reconciliation_blocked into v_mapping_owner, v_mapping_blocked
  from public.billing_customers
  where provider_customer_id = btrim(p_customer_id);

  if v_mapping_owner is distinct from p_owner_id then
    raise exception 'Billing ownership mismatch' using errcode = '55000';
  end if;
  if v_mapping_blocked and not p_reconciliation_blocked then
    raise exception 'Owner safety block must be cleared atomically' using errcode = '55000';
  end if;

  select owner_id, last_event_at into v_existing_owner, v_existing_event_at
  from public.subscriptions
  where provider_subscription_id = btrim(p_subscription_id);

  if v_existing_owner is not null and v_existing_owner is distinct from p_owner_id then
    raise exception 'Subscription ownership mismatch' using errcode = '55000';
  end if;
  if v_existing_event_at is not null and v_existing_event_at > p_observed_at then
    return false;
  end if;

  insert into public.subscriptions (
    provider_subscription_id, owner_id, price_key, status,
    current_period_end, cancel_at_period_end, last_event_at,
    reconciliation_blocked, last_reconciled_at
  ) values (
    btrim(p_subscription_id), p_owner_id, btrim(p_price_key), p_status,
    p_current_period_end, coalesce(p_cancel_at_period_end, false), p_observed_at,
    p_reconciliation_blocked, p_observed_at
  )
  on conflict (provider_subscription_id) do update set
    price_key = excluded.price_key,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_event_at = excluded.last_event_at,
    reconciliation_blocked = excluded.reconciliation_blocked,
    last_reconciled_at = excluded.last_reconciled_at;

  return true;
end;
$$;

create or replace function public.moxscore_set_owner_reconciliation_block(
  p_owner_id uuid,
  p_blocked boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null or p_blocked is null then
    raise exception 'Invalid reconciliation block' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_id::text || ':billing-reconcile'));
  update public.billing_customers
  set reconciliation_blocked = p_blocked
  where owner_id = p_owner_id;
  update public.subscriptions
  set reconciliation_blocked = p_blocked,
      last_reconciled_at = now()
  where owner_id = p_owner_id;
end;
$$;

-- Aggregate-only operator signal. It returns no owner, customer, subscription,
-- webhook-event, email, or payment identifier.
create or replace function public.moxscore_billing_operations_summary(
  p_webhook_stale_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.billing_reconciliation_state%rowtype;
  v_unprocessed bigint;
  v_stale bigint;
  v_failed bigint;
  v_oldest timestamptz;
begin
  if p_webhook_stale_seconds not between 60 and 86400 then
    raise exception 'Invalid backlog threshold' using errcode = '22023';
  end if;

  select * into v_state
  from public.billing_reconciliation_state
  where singleton = true;

  select count(*), min(received_at)
    into v_unprocessed, v_oldest
  from public.webhook_events
  where processed_at is null;

  select count(*) into v_stale
  from public.webhook_events
  where processed_at is null
    and received_at < now() - pg_catalog.make_interval(secs => p_webhook_stale_seconds);

  select count(*) into v_failed
  from public.webhook_events
  where result = 'failed';

  return jsonb_build_object(
    'unprocessed_webhooks', v_unprocessed,
    'stale_webhooks', v_stale,
    'failed_webhooks', v_failed,
    'oldest_unprocessed_at', v_oldest,
    'last_attempt_at', v_state.last_attempt_at,
    'last_page_success_at', v_state.last_page_success_at,
    'last_full_success_at', v_state.last_full_success_at,
    'last_failure_at', v_state.last_failure_at,
    'last_status', v_state.last_status,
    'last_counts', v_state.last_counts,
    'next_customer_key', v_state.next_customer_key,
    'run_in_progress', v_state.active_run_id is not null and v_state.lease_expires_at > now()
  );
end;
$$;

revoke all on function public.moxscore_claim_webhook_event(text, text) from public, anon, authenticated;
revoke all on function public.moxscore_project_subscription(text, uuid, text, text, timestamptz, boolean, timestamptz) from service_role;
revoke all on function public.moxscore_project_subscription(text, text, uuid, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.moxscore_start_billing_reconciliation(text, text, integer) from public, anon, authenticated;
revoke all on function public.moxscore_finish_billing_reconciliation(text, text, bigint, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.moxscore_reconcile_subscription(text, text, uuid, text, text, timestamptz, boolean, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.moxscore_set_owner_reconciliation_block(uuid, boolean) from public, anon, authenticated;
revoke all on function public.moxscore_billing_operations_summary(integer) from public, anon, authenticated;

grant execute on function public.moxscore_claim_webhook_event(text, text) to service_role;
grant execute on function public.moxscore_project_subscription(text, text, uuid, text, text, timestamptz, boolean, timestamptz) to service_role;
grant execute on function public.moxscore_start_billing_reconciliation(text, text, integer) to service_role;
grant execute on function public.moxscore_finish_billing_reconciliation(text, text, bigint, boolean, jsonb) to service_role;
grant execute on function public.moxscore_reconcile_subscription(text, text, uuid, text, text, timestamptz, boolean, timestamptz, boolean) to service_role;
grant execute on function public.moxscore_set_owner_reconciliation_block(uuid, boolean) to service_role;
grant execute on function public.moxscore_billing_operations_summary(integer) to service_role;
