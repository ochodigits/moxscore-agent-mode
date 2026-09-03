-- Paid control plane: billing customers, subscription projection, webhook
-- idempotency ledger, and durable AI usage accounting.
--
-- These tables are strictly server-side. Unlike profiles/saved_decks, browser
-- roles get no select grant and no RLS read policy at all: entitlement reaches
-- the browser only as derived capability booleans from /api/me. A client that
-- can read raw subscription rows can also learn price keys and period ends it
-- has no reason to see, and every capability decision is made on the server.
--
-- Creating these tables grants nothing. Capabilities still require the feature
-- flag plus C1 operating readiness in Production (see api/_featureFlags.ts).

-- ---------------------------------------------------------------------------
-- billing_customers
-- ---------------------------------------------------------------------------

create table if not exists public.billing_customers (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_customer_id text not null unique
    check (char_length(btrim(provider_customer_id)) between 1 and 255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists billing_customers_set_updated_at on public.billing_customers;
create trigger billing_customers_set_updated_at
  before update on public.billing_customers
  for each row execute function public.moxscore_set_updated_at();

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------

-- Status values are the provider's own vocabulary. Which of them grant a
-- capability is an application decision in api/_entitlement.ts, deliberately
-- not encoded here: a pricing or grace-period change must not need a migration.
create table if not exists public.subscriptions (
  provider_subscription_id text primary key
    check (char_length(btrim(provider_subscription_id)) between 1 and 255),
  owner_id uuid not null references auth.users(id) on delete cascade,
  price_key text not null check (char_length(btrim(price_key)) between 1 and 100),
  status text not null check (status in (
    'active', 'trialing', 'past_due', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused', 'canceled'
  )),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Provider event timestamp, not our clock. Out-of-order webhook delivery is
  -- rejected by comparing against this rather than against now().
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_owner_idx on public.subscriptions (owner_id);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.moxscore_set_updated_at();

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------

-- Idempotency ledger. The provider's event id is the primary key, so a
-- redelivery collides instead of repeating side effects. Raw payloads are
-- deliberately not stored.
create table if not exists public.webhook_events (
  provider_event_id text primary key
    check (char_length(btrim(provider_event_id)) between 1 and 255),
  event_type text not null check (char_length(btrim(event_type)) between 1 and 100),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text check (result in ('processed', 'ignored', 'failed'))
);

create index if not exists webhook_events_unprocessed_idx
  on public.webhook_events (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- ai_usage
-- ---------------------------------------------------------------------------

-- One row per provider call attempt. request_id is unique so a retried request
-- cannot consume the user's allowance twice.
create table if not exists public.ai_usage (
  request_id text primary key check (char_length(btrim(request_id)) between 1 and 255),
  owner_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (operation in ('tune_explanation', 'suggest_plan')),
  usage_date date not null default (now() at time zone 'utc')::date,
  usage_month date not null default date_trunc('month', now() at time zone 'utc')::date,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_micros bigint not null default 0 check (estimated_cost_micros >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_owner_month_idx on public.ai_usage (owner_id, usage_month);
create index if not exists ai_usage_owner_date_idx on public.ai_usage (owner_id, usage_date);
create index if not exists ai_usage_owner_created_idx on public.ai_usage (owner_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.webhook_events enable row level security;
alter table public.ai_usage enable row level security;

-- No browser role may touch the commercial control plane, by any path.
revoke all privileges on table public.billing_customers from public, anon, authenticated;
revoke all privileges on table public.subscriptions from public, anon, authenticated;
revoke all privileges on table public.webhook_events from public, anon, authenticated;
revoke all privileges on table public.ai_usage from public, anon, authenticated;

-- RLS is enabled with no policy for authenticated: even a future accidental
-- grant leaves zero rows visible.

revoke all privileges on table public.billing_customers from service_role;
revoke all privileges on table public.subscriptions from service_role;
revoke all privileges on table public.webhook_events from service_role;
revoke all privileges on table public.ai_usage from service_role;
grant select, insert, update on public.billing_customers to service_role;
grant select on public.subscriptions to service_role;
grant select on public.webhook_events to service_role;
grant select on public.ai_usage to service_role;

-- Subscription and usage writes go exclusively through the definer functions
-- below, so ordering and quota rules cannot be bypassed by an ad hoc update.

-- ---------------------------------------------------------------------------
-- moxscore_record_webhook_event
-- ---------------------------------------------------------------------------

-- Returns true when the caller should process this event, false when it was
-- already handled. Call before any side effect.
--
-- A previous attempt that failed, or one that died mid-flight and left
-- processed_at null past the stale window, is re-claimable: otherwise a single
-- transient database error would make Stripe's retry look like a duplicate and
-- the event would be dropped permanently.
create or replace function public.moxscore_record_webhook_event(
  p_event_id text,
  p_event_type text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed_at timestamptz;
  v_result text;
  v_received_at timestamptz;
begin
  if p_event_id is null or char_length(btrim(coalesce(p_event_id, ''))) not between 1 and 255 then
    raise exception 'Invalid webhook event' using errcode = '22023';
  end if;

  -- Serializes concurrent deliveries of the same event id so two workers
  -- cannot both claim it.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_event_id)));

  insert into public.webhook_events (provider_event_id, event_type)
  values (btrim(p_event_id), btrim(p_event_type))
  on conflict (provider_event_id) do nothing;

  -- FOUND is false when the conflict clause suppressed the insert.
  if found then
    return true;
  end if;

  select processed_at, result, received_at
    into v_processed_at, v_result, v_received_at
  from public.webhook_events
  where provider_event_id = btrim(p_event_id);

  if v_result = 'failed' or (v_processed_at is null and v_received_at < now() - interval '5 minutes') then
    update public.webhook_events
    set received_at = now(), processed_at = null, result = null
    where provider_event_id = btrim(p_event_id);
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.moxscore_complete_webhook_event(
  p_event_id text,
  p_result text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_result not in ('processed', 'ignored', 'failed') then
    raise exception 'Invalid webhook result' using errcode = '22023';
  end if;

  update public.webhook_events
  set processed_at = now(), result = p_result
  where provider_event_id = btrim(p_event_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- moxscore_project_subscription
-- ---------------------------------------------------------------------------

-- Projects one provider event into local subscription state. An event older
-- than the row's last_event_at is discarded, so retries and out-of-order
-- delivery cannot resurrect a stale status. Returns true when state was
-- written, false when the event was stale.
create or replace function public.moxscore_project_subscription(
  p_subscription_id text,
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
  existing_event_at timestamptz;
begin
  if p_subscription_id is null or p_owner_id is null or p_event_at is null then
    raise exception 'Invalid subscription projection' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_subscription_id)));

  select last_event_at into existing_event_at
  from public.subscriptions
  where provider_subscription_id = btrim(p_subscription_id);

  if existing_event_at is not null and existing_event_at > p_event_at then
    return false;
  end if;

  insert into public.subscriptions (
    provider_subscription_id, owner_id, price_key, status,
    current_period_end, cancel_at_period_end, last_event_at
  )
  values (
    btrim(p_subscription_id), p_owner_id, btrim(p_price_key), p_status,
    p_current_period_end, coalesce(p_cancel_at_period_end, false), p_event_at
  )
  on conflict (provider_subscription_id) do update set
    owner_id = excluded.owner_id,
    price_key = excluded.price_key,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_event_at = excluded.last_event_at;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- moxscore_delete_billing_owner
-- ---------------------------------------------------------------------------

-- Removes the local commercial identity only after the server has deleted the
-- corresponding Stripe customer. Deleting the Stripe customer immediately
-- cancels its subscriptions; clearing this projection before deleting the Auth
-- user prevents either an orphaned renewal or a stale local entitlement if the
-- subsequent Auth deletion needs to be retried.
create or replace function public.moxscore_delete_billing_owner(p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null then
    raise exception 'Invalid billing owner' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_id::text || ':billing-delete'));
  delete from public.subscriptions where owner_id = p_owner_id;
  delete from public.billing_customers where owner_id = p_owner_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- moxscore_consume_ai_quota
-- ---------------------------------------------------------------------------

-- Atomically claims one usage unit before a provider call. Limits are passed
-- in by the caller so pricing changes stay in application configuration.
-- Returns the decision plus remaining counts for the response envelope.
create or replace function public.moxscore_consume_ai_quota(
  p_owner_id uuid,
  p_operation text,
  p_request_id text,
  p_monthly_limit integer,
  p_daily_limit integer,
  p_minute_limit integer
)
returns table (allowed boolean, reason text, month_used integer, day_used integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v_day date := (now() at time zone 'utc')::date;
  v_month_used integer;
  v_day_used integer;
  v_minute_used integer;
begin
  if p_owner_id is null or p_request_id is null then
    raise exception 'Invalid quota request' using errcode = '22023';
  end if;

  -- Serialize this user's quota checks so two concurrent requests cannot both
  -- observe the last remaining unit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_id::text || ':ai'));

  -- A replayed request id was already charged; report success without
  -- consuming a second unit.
  if exists (select 1 from public.ai_usage where request_id = btrim(p_request_id)) then
    select count(*) into v_month_used from public.ai_usage
      where owner_id = p_owner_id and usage_month = v_month;
    select count(*) into v_day_used from public.ai_usage
      where owner_id = p_owner_id and usage_date = v_day;
    return query select true, 'replay'::text, v_month_used, v_day_used;
    return;
  end if;

  select count(*) into v_month_used from public.ai_usage
    where owner_id = p_owner_id and usage_month = v_month;
  select count(*) into v_day_used from public.ai_usage
    where owner_id = p_owner_id and usage_date = v_day;
  select count(*) into v_minute_used from public.ai_usage
    where owner_id = p_owner_id and created_at > now() - interval '1 minute';

  if v_month_used >= p_monthly_limit then
    return query select false, 'monthly_limit'::text, v_month_used, v_day_used;
    return;
  end if;
  if v_day_used >= p_daily_limit then
    return query select false, 'daily_limit'::text, v_month_used, v_day_used;
    return;
  end if;
  if v_minute_used >= p_minute_limit then
    return query select false, 'burst_limit'::text, v_month_used, v_day_used;
    return;
  end if;

  insert into public.ai_usage (request_id, owner_id, operation, usage_date, usage_month)
  values (btrim(p_request_id), p_owner_id, p_operation, v_day, v_month);

  return query select true, 'granted'::text, v_month_used + 1, v_day_used + 1;
end;
$$;

-- Records real token cost after the provider responds. Never re-checks quota:
-- the unit was already claimed by moxscore_consume_ai_quota.
create or replace function public.moxscore_record_ai_cost(
  p_request_id text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_micros bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_usage
  set input_tokens = greatest(0, coalesce(p_input_tokens, 0)),
      output_tokens = greatest(0, coalesce(p_output_tokens, 0)),
      estimated_cost_micros = greatest(0, coalesce(p_estimated_cost_micros, 0))
  where request_id = btrim(p_request_id);
end;
$$;

-- Releases a claimed unit when no provider request was actually made. Only a
-- never-charged row is removed, so a failed call that did reach the provider
-- still counts against the allowance.
create or replace function public.moxscore_refund_ai_quota(p_request_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.ai_usage
  where request_id = btrim(p_request_id)
    and input_tokens = 0
    and output_tokens = 0
    and estimated_cost_micros = 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.moxscore_record_webhook_event(text, text) from public, anon, authenticated;
revoke all on function public.moxscore_complete_webhook_event(text, text) from public, anon, authenticated;
revoke all on function public.moxscore_project_subscription(text, uuid, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.moxscore_delete_billing_owner(uuid) from public, anon, authenticated;
revoke all on function public.moxscore_consume_ai_quota(uuid, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.moxscore_record_ai_cost(text, integer, integer, bigint) from public, anon, authenticated;
revoke all on function public.moxscore_refund_ai_quota(text) from public, anon, authenticated;

grant execute on function public.moxscore_record_webhook_event(text, text) to service_role;
grant execute on function public.moxscore_complete_webhook_event(text, text) to service_role;
grant execute on function public.moxscore_project_subscription(text, uuid, text, text, timestamptz, boolean, timestamptz) to service_role;
grant execute on function public.moxscore_delete_billing_owner(uuid) to service_role;
grant execute on function public.moxscore_consume_ai_quota(uuid, text, text, integer, integer, integer) to service_role;
grant execute on function public.moxscore_record_ai_cost(text, integer, integer, bigint) to service_role;
grant execute on function public.moxscore_refund_ai_quota(text) to service_role;
