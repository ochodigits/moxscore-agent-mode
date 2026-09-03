-- Constrained Pro AI controls: owner/input-bound replay, response cache,
-- durable quota, global spend/concurrency leases, aggregate metrics, and
-- bounded feedback. No prompt or decklist is stored.

alter table public.ai_usage
  add column if not exists provider_contacted boolean not null default false;
alter table public.ai_usage
  add column if not exists provider text check (provider is null or provider in ('anthropic', 'openai'));
alter table public.ai_usage
  add column if not exists model text check (model is null or char_length(model) between 1 and 100);
alter table public.ai_usage
  add column if not exists status text not null default 'reserved'
    check (status in ('reserved', 'completed'));
alter table public.ai_usage
  add column if not exists outcome text check (outcome is null or outcome in (
    'success', 'partial_fallback', 'invalid_output', 'provider_error'
  ));
alter table public.ai_usage
  add column if not exists latency_ms integer check (latency_ms is null or latency_ms between 0 and 120000);
alter table public.ai_usage
  add column if not exists completed_at timestamptz;

create table if not exists public.ai_explanation_requests (
  request_id text primary key references public.ai_usage(request_id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'completed')),
  response jsonb check (response is null or jsonb_typeof(response) = 'object'),
  request_schema_version text not null check (char_length(request_schema_version) between 1 and 100),
  prompt_version text not null check (char_length(prompt_version) between 1 and 100),
  provider text check (provider is null or provider in ('anthropic', 'openai')),
  model text check (model is null or char_length(model) between 1 and 100),
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '35 days')
);

create index if not exists ai_explanation_requests_owner_created_idx
  on public.ai_explanation_requests (owner_id, created_at desc);
create index if not exists ai_explanation_requests_expiry_idx
  on public.ai_explanation_requests (expires_at);

create table if not exists public.ai_provider_leases (
  request_id text primary key references public.ai_usage(request_id) on delete cascade,
  reservation_micros bigint not null check (reservation_micros > 0),
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_provider_leases_expiry_idx
  on public.ai_provider_leases (lease_expires_at);

-- Aggregate-only counters. There is no owner, request, card, prompt, deck, or
-- provider payload in this table.
create table if not exists public.ai_operation_metrics (
  usage_date date primary key,
  request_count bigint not null default 0 check (request_count >= 0),
  provider_call_count bigint not null default 0 check (provider_call_count >= 0),
  fallback_count bigint not null default 0 check (fallback_count >= 0),
  quota_denial_count bigint not null default 0 check (quota_denial_count >= 0),
  error_count bigint not null default 0 check (error_count >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  estimated_cost_micros bigint not null default 0 check (estimated_cost_micros >= 0),
  latency_total_ms bigint not null default 0 check (latency_total_ms >= 0),
  latency_sample_count bigint not null default 0 check (latency_sample_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_explanation_feedback (
  request_id text not null references public.ai_explanation_requests(request_id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  rating text not null check (rating in ('up', 'down')),
  reason_code text check (reason_code is null or reason_code in (
    'helpful', 'irrelevant', 'unclear', 'unsupported', 'too_generic'
  )),
  created_at timestamptz not null default now(),
  primary key (request_id, owner_id)
);

alter table public.ai_explanation_requests enable row level security;
alter table public.ai_provider_leases enable row level security;
alter table public.ai_operation_metrics enable row level security;
alter table public.ai_explanation_feedback enable row level security;

revoke all privileges on table public.ai_explanation_requests from public, anon, authenticated, service_role;
revoke all privileges on table public.ai_provider_leases from public, anon, authenticated, service_role;
revoke all privileges on table public.ai_operation_metrics from public, anon, authenticated, service_role;
revoke all privileges on table public.ai_explanation_feedback from public, anon, authenticated, service_role;

-- Harden the existing named quota function. A request ID owned by someone
-- else is a conflict, never a replay, and only the constrained explanation
-- operation can consume new quota.
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
  v_existing_owner uuid;
  v_has_existing boolean;
begin
  if p_owner_id is null
    or p_operation <> 'tune_explanation'
    or char_length(btrim(coalesce(p_request_id, ''))) not between 16 and 100
    or p_monthly_limit not between 1 and 1000
    or p_daily_limit not between 1 and 100
    or p_minute_limit not between 1 and 20 then
    raise exception 'Invalid quota request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_request_id)));

  -- A completed cache has a fixed retention window. Deleting the request also
  -- cascades its usage and feedback rows; aggregate metrics remain anonymous.
  delete from public.ai_usage usage
  where usage.request_id = btrim(p_request_id)
    and exists (
      select 1 from public.ai_explanation_requests requests
      where requests.request_id = usage.request_id and requests.expires_at <= now()
    );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_owner_id::text || ':ai'));

  select owner_id into v_existing_owner
  from public.ai_usage
  where request_id = btrim(p_request_id);
  v_has_existing := found;

  select count(*) into v_month_used from public.ai_usage
    where owner_id = p_owner_id and usage_month = v_month;
  select count(*) into v_day_used from public.ai_usage
    where owner_id = p_owner_id and usage_date = v_day;

  if v_has_existing then
    if v_existing_owner is distinct from p_owner_id then
      return query select false, 'request_conflict'::text, v_month_used, v_day_used;
    else
      return query select true, 'replay'::text, v_month_used, v_day_used;
    end if;
    return;
  end if;

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
  values (btrim(p_request_id), p_owner_id, 'tune_explanation', v_day, v_month);

  return query select true, 'granted'::text, v_month_used + 1, v_day_used + 1;
end;
$$;

create or replace function public.moxscore_claim_ai_explanation(
  p_owner_id uuid,
  p_request_id text,
  p_input_hash text,
  p_request_schema_version text,
  p_prompt_version text,
  p_monthly_limit integer,
  p_daily_limit integer,
  p_minute_limit integer,
  p_lease_seconds integer
)
returns table (decision text, month_used integer, day_used integer, cached_response jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.ai_explanation_requests%rowtype;
  v_provider_contacted boolean;
  v_allowed boolean;
  v_reason text;
  v_month_used integer;
  v_day_used integer;
begin
  if p_owner_id is null
    or char_length(btrim(coalesce(p_request_id, ''))) not between 16 and 100
    or coalesce(p_input_hash, '') !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_request_schema_version, ''))) not between 1 and 100
    or char_length(btrim(coalesce(p_prompt_version, ''))) not between 1 and 100
    or p_lease_seconds not between 30 and 180 then
    raise exception 'Invalid explanation claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_request_id)));

  select * into v_request
  from public.ai_explanation_requests
  where request_id = btrim(p_request_id);

  if found then
    select count(*) into v_month_used from public.ai_usage
      where owner_id = p_owner_id and usage_month = date_trunc('month', now() at time zone 'utc')::date;
    select count(*) into v_day_used from public.ai_usage
      where owner_id = p_owner_id and usage_date = (now() at time zone 'utc')::date;

    if v_request.owner_id is distinct from p_owner_id or v_request.input_hash <> p_input_hash then
      return query select 'request_conflict'::text, v_month_used, v_day_used, null::jsonb;
    elsif v_request.status = 'completed' and v_request.response is not null then
      return query select 'completed'::text, v_month_used, v_day_used, v_request.response;
    elsif v_request.lease_expires_at > now() then
      return query select 'in_progress'::text, v_month_used, v_day_used, null::jsonb;
    end if;

    select provider_contacted into v_provider_contacted
    from public.ai_usage where request_id = btrim(p_request_id);
    if coalesce(v_provider_contacted, false) then
      return query select 'ambiguous_provider'::text, v_month_used, v_day_used, null::jsonb;
    end if;

    update public.ai_explanation_requests
    set lease_expires_at = now() + pg_catalog.make_interval(secs => p_lease_seconds)
    where request_id = btrim(p_request_id);
    return query select 'acquired'::text, v_month_used, v_day_used, null::jsonb;
    return;
  end if;

  select quota.allowed, quota.reason, quota.month_used, quota.day_used
    into v_allowed, v_reason, v_month_used, v_day_used
  from public.moxscore_consume_ai_quota(
    p_owner_id, 'tune_explanation', btrim(p_request_id),
    p_monthly_limit, p_daily_limit, p_minute_limit
  ) quota;

  if not coalesce(v_allowed, false) then
    return query select v_reason, v_month_used, v_day_used, null::jsonb;
    return;
  end if;

  -- A pre-migration/legacy usage ID has no input-bound cache record. Never
  -- turn that unbound replay into a free provider call.
  if v_reason = 'replay' then
    return query select 'request_conflict'::text, v_month_used, v_day_used, null::jsonb;
    return;
  end if;

  insert into public.ai_explanation_requests (
    request_id, owner_id, input_hash, request_schema_version,
    prompt_version, lease_expires_at
  ) values (
    btrim(p_request_id), p_owner_id, p_input_hash,
    btrim(p_request_schema_version), btrim(p_prompt_version),
    now() + pg_catalog.make_interval(secs => p_lease_seconds)
  );

  return query select 'acquired'::text, v_month_used, v_day_used, null::jsonb;
end;
$$;

create or replace function public.moxscore_reserve_ai_provider_capacity(
  p_request_id text,
  p_daily_budget_micros bigint,
  p_monthly_budget_micros bigint,
  p_concurrency_limit integer,
  p_reservation_micros bigint,
  p_lease_seconds integer
)
returns table (
  allowed boolean,
  reason text,
  daily_committed_micros bigint,
  monthly_committed_micros bigint,
  active_leases integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_daily bigint;
  v_monthly bigint;
  v_reserved_daily bigint;
  v_reserved_monthly bigint;
  v_active integer;
begin
  if char_length(btrim(coalesce(p_request_id, ''))) not between 16 and 100
    or p_daily_budget_micros not between 1 and 1000000000000
    or p_monthly_budget_micros not between 1 and 10000000000000
    or p_daily_budget_micros > p_monthly_budget_micros
    or p_concurrency_limit not between 1 and 20
    or p_reservation_micros not between 1 and p_daily_budget_micros
    or p_lease_seconds not between 30 and 180 then
    raise exception 'Invalid provider capacity request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('moxscore:ai-provider-capacity'));
  delete from public.ai_provider_leases where lease_expires_at <= now();

  select coalesce(sum(estimated_cost_micros), 0) into v_daily
  from public.ai_usage where usage_date = (now() at time zone 'utc')::date;
  select coalesce(sum(estimated_cost_micros), 0) into v_monthly
  from public.ai_usage where usage_month = date_trunc('month', now() at time zone 'utc')::date;
  select coalesce(sum(leases.reservation_micros), 0) into v_reserved_daily
  from public.ai_provider_leases leases
  join public.ai_usage usage using (request_id)
  where not usage.provider_contacted
    and leases.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  select coalesce(sum(leases.reservation_micros), 0) into v_reserved_monthly
  from public.ai_provider_leases leases
  join public.ai_usage usage using (request_id)
  where not usage.provider_contacted
    and leases.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  select count(*) into v_active from public.ai_provider_leases;

  if exists (select 1 from public.ai_provider_leases where request_id = btrim(p_request_id)) then
    return query select true, 'replay'::text, v_daily + v_reserved_daily, v_monthly + v_reserved_monthly, v_active;
    return;
  end if;
  if v_daily + v_reserved_daily + p_reservation_micros > p_daily_budget_micros then
    return query select false, 'daily_budget'::text, v_daily + v_reserved_daily, v_monthly + v_reserved_monthly, v_active;
    return;
  end if;
  if v_monthly + v_reserved_monthly + p_reservation_micros > p_monthly_budget_micros then
    return query select false, 'monthly_budget'::text, v_daily + v_reserved_daily, v_monthly + v_reserved_monthly, v_active;
    return;
  end if;
  if v_active >= p_concurrency_limit then
    return query select false, 'concurrency'::text, v_daily + v_reserved_daily, v_monthly + v_reserved_monthly, v_active;
    return;
  end if;

  insert into public.ai_provider_leases (request_id, reservation_micros, lease_expires_at)
  values (
    btrim(p_request_id), p_reservation_micros,
    now() + pg_catalog.make_interval(secs => p_lease_seconds)
  );

  return query select true, 'granted'::text,
    v_daily + v_reserved_daily + p_reservation_micros,
    v_monthly + v_reserved_monthly + p_reservation_micros,
    v_active + 1;
end;
$$;

create or replace function public.moxscore_mark_ai_provider_contacted(
  p_request_id text,
  p_provider text,
  p_model text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider not in ('anthropic', 'openai')
    or char_length(btrim(coalesce(p_model, ''))) not between 1 and 100 then
    raise exception 'Invalid provider marker' using errcode = '22023';
  end if;

  update public.ai_usage usage
  set provider_contacted = true,
      provider = p_provider,
      model = btrim(p_model),
      -- Persist the conservative reservation before the network boundary.
      -- If the worker disappears after the call, spend remains accounted.
      estimated_cost_micros = leases.reservation_micros
  from public.ai_provider_leases leases
  where usage.request_id = btrim(p_request_id)
    and leases.request_id = usage.request_id
    and leases.lease_expires_at > now()
    and usage.status = 'reserved'
    and usage.provider_contacted = false
    and exists (
      select 1 from public.ai_explanation_requests requests
      where requests.request_id = usage.request_id and requests.status = 'processing'
    );
  if not found then return false; end if;

  update public.ai_explanation_requests
  set provider = p_provider, model = btrim(p_model)
  where request_id = btrim(p_request_id);
  return true;
end;
$$;

-- Existing named cost RPC, now also releases global concurrency atomically.
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
  if p_input_tokens not between 0 and 10000000
    or p_output_tokens not between 0 and 10000000
    or p_estimated_cost_micros not between 0 and 1000000000000 then
    raise exception 'Invalid AI cost' using errcode = '22023';
  end if;
  update public.ai_usage
  set input_tokens = p_input_tokens,
      output_tokens = p_output_tokens,
      estimated_cost_micros = p_estimated_cost_micros,
      provider_contacted = true
  where request_id = btrim(p_request_id) and provider_contacted = true;
  if not found then
    raise exception 'AI usage not found' using errcode = 'P0002';
  end if;
  delete from public.ai_provider_leases where request_id = btrim(p_request_id);
end;
$$;

-- Existing named refund RPC. It succeeds only while the durable provider
-- marker proves no provider request was attempted.
create or replace function public.moxscore_refund_ai_quota(p_request_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_request_id)));
  delete from public.ai_usage
  where request_id = btrim(p_request_id)
    and provider_contacted = false
    and input_tokens = 0
    and output_tokens = 0
    and estimated_cost_micros = 0;
end;
$$;

create or replace function public.moxscore_record_ai_metric(
  p_outcome text,
  p_provider_called boolean,
  p_latency_ms integer,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_micros bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fallback boolean;
  v_quota_denial boolean;
  v_error boolean;
begin
  if p_outcome not in (
      'success', 'partial_fallback', 'invalid_output', 'provider_error',
      'switch_off', 'config_closed', 'quota_denied', 'budget_denied',
      'concurrency_denied', 'input_too_large', 'control_unavailable', 'replay'
    )
    or p_provider_called is null
    or p_latency_ms not between 0 and 120000
    or p_input_tokens not between 0 and 10000000
    or p_output_tokens not between 0 and 10000000
    or p_cost_micros not between 0 and 1000000000000 then
    raise exception 'Invalid AI metric' using errcode = '22023';
  end if;
  v_fallback := p_outcome not in ('success', 'replay');
  v_quota_denial := p_outcome = 'quota_denied';
  v_error := p_outcome in ('invalid_output', 'provider_error', 'control_unavailable');

  insert into public.ai_operation_metrics (
    usage_date, request_count, provider_call_count, fallback_count,
    quota_denial_count, error_count, input_tokens, output_tokens,
    estimated_cost_micros, latency_total_ms, latency_sample_count
  ) values (
    (now() at time zone 'utc')::date,
    1, p_provider_called::integer, v_fallback::integer,
    v_quota_denial::integer, v_error::integer,
    p_input_tokens, p_output_tokens, p_cost_micros,
    case when p_provider_called then p_latency_ms else 0 end,
    p_provider_called::integer
  )
  on conflict (usage_date) do update set
    request_count = public.ai_operation_metrics.request_count + 1,
    provider_call_count = public.ai_operation_metrics.provider_call_count + excluded.provider_call_count,
    fallback_count = public.ai_operation_metrics.fallback_count + excluded.fallback_count,
    quota_denial_count = public.ai_operation_metrics.quota_denial_count + excluded.quota_denial_count,
    error_count = public.ai_operation_metrics.error_count + excluded.error_count,
    input_tokens = public.ai_operation_metrics.input_tokens + excluded.input_tokens,
    output_tokens = public.ai_operation_metrics.output_tokens + excluded.output_tokens,
    estimated_cost_micros = public.ai_operation_metrics.estimated_cost_micros + excluded.estimated_cost_micros,
    latency_total_ms = public.ai_operation_metrics.latency_total_ms + excluded.latency_total_ms,
    latency_sample_count = public.ai_operation_metrics.latency_sample_count + excluded.latency_sample_count,
    updated_at = now();
end;
$$;

create or replace function public.moxscore_complete_ai_explanation(
  p_request_id text,
  p_response jsonb,
  p_outcome text,
  p_latency_ms integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage public.ai_usage%rowtype;
begin
  if p_response is null or jsonb_typeof(p_response) <> 'object'
    or p_outcome not in ('success', 'partial_fallback', 'invalid_output', 'provider_error')
    or p_latency_ms not between 0 and 120000 then
    raise exception 'Invalid explanation completion' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(btrim(p_request_id)));
  select * into v_usage from public.ai_usage where request_id = btrim(p_request_id);
  if not found or not v_usage.provider_contacted then
    raise exception 'Provider contact was not recorded' using errcode = '55000';
  end if;

  update public.ai_usage
  set status = 'completed', outcome = p_outcome,
      latency_ms = p_latency_ms, completed_at = now()
  where request_id = btrim(p_request_id);

  update public.ai_explanation_requests
  set status = 'completed', response = p_response,
      lease_expires_at = now(), completed_at = now(),
      expires_at = now() + interval '35 days'
  where request_id = btrim(p_request_id);

  perform public.moxscore_record_ai_metric(
    p_outcome, true, p_latency_ms,
    v_usage.input_tokens, v_usage.output_tokens, v_usage.estimated_cost_micros
  );
end;
$$;

create or replace function public.moxscore_ai_quota_summary(
  p_owner_id uuid,
  p_monthly_limit integer,
  p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month integer;
  v_day integer;
begin
  if p_owner_id is null or p_monthly_limit not between 1 and 1000 or p_daily_limit not between 1 and 100 then
    raise exception 'Invalid quota summary' using errcode = '22023';
  end if;
  select count(*) into v_month from public.ai_usage
    where owner_id = p_owner_id and usage_month = date_trunc('month', now() at time zone 'utc')::date;
  select count(*) into v_day from public.ai_usage
    where owner_id = p_owner_id and usage_date = (now() at time zone 'utc')::date;
  return jsonb_build_object(
    'monthly_limit', p_monthly_limit,
    'monthly_used', v_month,
    'monthly_remaining', greatest(0, p_monthly_limit - v_month),
    'daily_limit', p_daily_limit,
    'daily_used', v_day,
    'daily_remaining', greatest(0, p_daily_limit - v_day)
  );
end;
$$;

create or replace function public.moxscore_record_ai_feedback(
  p_owner_id uuid,
  p_request_id text,
  p_rating text,
  p_reason_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null
    or p_rating not in ('up', 'down')
    or (p_reason_code is not null and p_reason_code not in ('helpful', 'irrelevant', 'unclear', 'unsupported', 'too_generic')) then
    raise exception 'Invalid AI feedback' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.ai_explanation_requests
    where request_id = btrim(p_request_id)
      and owner_id = p_owner_id
      and status = 'completed'
  ) then
    raise exception 'Explanation not found' using errcode = 'P0002';
  end if;
  insert into public.ai_explanation_feedback (request_id, owner_id, rating, reason_code)
  values (btrim(p_request_id), p_owner_id, p_rating, p_reason_code)
  on conflict (request_id, owner_id) do update set
    rating = excluded.rating, reason_code = excluded.reason_code, created_at = now();
end;
$$;

create or replace function public.moxscore_ai_operations_summary()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today public.ai_operation_metrics%rowtype;
  v_month jsonb;
  v_active integer;
begin
  select * into v_today from public.ai_operation_metrics
    where usage_date = (now() at time zone 'utc')::date;
  select jsonb_build_object(
    'request_count', coalesce(sum(request_count), 0),
    'provider_call_count', coalesce(sum(provider_call_count), 0),
    'fallback_count', coalesce(sum(fallback_count), 0),
    'quota_denial_count', coalesce(sum(quota_denial_count), 0),
    'error_count', coalesce(sum(error_count), 0),
    'input_tokens', coalesce(sum(input_tokens), 0),
    'output_tokens', coalesce(sum(output_tokens), 0),
    'estimated_cost_micros', coalesce(sum(estimated_cost_micros), 0),
    'latency_total_ms', coalesce(sum(latency_total_ms), 0),
    'latency_sample_count', coalesce(sum(latency_sample_count), 0)
  ) into v_month
  from public.ai_operation_metrics
  where usage_date >= date_trunc('month', now() at time zone 'utc')::date;
  select count(*) into v_active from public.ai_provider_leases where lease_expires_at > now();

  return jsonb_build_object(
    'today', jsonb_build_object(
      'request_count', coalesce(v_today.request_count, 0),
      'provider_call_count', coalesce(v_today.provider_call_count, 0),
      'fallback_count', coalesce(v_today.fallback_count, 0),
      'quota_denial_count', coalesce(v_today.quota_denial_count, 0),
      'error_count', coalesce(v_today.error_count, 0),
      'input_tokens', coalesce(v_today.input_tokens, 0),
      'output_tokens', coalesce(v_today.output_tokens, 0),
      'estimated_cost_micros', coalesce(v_today.estimated_cost_micros, 0),
      'latency_total_ms', coalesce(v_today.latency_total_ms, 0),
      'latency_sample_count', coalesce(v_today.latency_sample_count, 0)
    ),
    'month', v_month,
    'active_provider_leases', v_active
  );
end;
$$;

create or replace function public.moxscore_prune_ai_explanations(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_limit not between 1 and 5000 then
    raise exception 'Invalid AI prune limit' using errcode = '22023';
  end if;
  with expired as (
    select request_id from public.ai_explanation_requests
    where expires_at <= now()
    order by expires_at, request_id
    limit p_limit
    for update skip locked
  )
  delete from public.ai_usage usage
  using expired
  where usage.request_id = expired.request_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.moxscore_consume_ai_quota(uuid, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.moxscore_claim_ai_explanation(uuid, text, text, text, text, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.moxscore_reserve_ai_provider_capacity(text, bigint, bigint, integer, bigint, integer) from public, anon, authenticated;
revoke all on function public.moxscore_mark_ai_provider_contacted(text, text, text) from public, anon, authenticated;
revoke all on function public.moxscore_record_ai_cost(text, integer, integer, bigint) from public, anon, authenticated;
revoke all on function public.moxscore_refund_ai_quota(text) from public, anon, authenticated;
revoke all on function public.moxscore_record_ai_metric(text, boolean, integer, integer, integer, bigint) from public, anon, authenticated;
revoke all on function public.moxscore_complete_ai_explanation(text, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.moxscore_ai_quota_summary(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.moxscore_record_ai_feedback(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.moxscore_ai_operations_summary() from public, anon, authenticated;
revoke all on function public.moxscore_prune_ai_explanations(integer) from public, anon, authenticated;

grant execute on function public.moxscore_consume_ai_quota(uuid, text, text, integer, integer, integer) to service_role;
grant execute on function public.moxscore_claim_ai_explanation(uuid, text, text, text, text, integer, integer, integer, integer) to service_role;
grant execute on function public.moxscore_reserve_ai_provider_capacity(text, bigint, bigint, integer, bigint, integer) to service_role;
grant execute on function public.moxscore_mark_ai_provider_contacted(text, text, text) to service_role;
grant execute on function public.moxscore_record_ai_cost(text, integer, integer, bigint) to service_role;
grant execute on function public.moxscore_refund_ai_quota(text) to service_role;
grant execute on function public.moxscore_record_ai_metric(text, boolean, integer, integer, integer, bigint) to service_role;
grant execute on function public.moxscore_complete_ai_explanation(text, jsonb, text, integer) to service_role;
grant execute on function public.moxscore_ai_quota_summary(uuid, integer, integer) to service_role;
grant execute on function public.moxscore_record_ai_feedback(uuid, text, text, text) to service_role;
grant execute on function public.moxscore_ai_operations_summary() to service_role;
grant execute on function public.moxscore_prune_ai_explanations(integer) to service_role;
