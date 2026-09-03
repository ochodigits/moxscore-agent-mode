-- Allow OpenRouter as an explicit AI provider identity alongside anthropic/openai.
-- Additive only: existing rows and RPCs remain valid.

do $$
declare
  r record;
begin
  for r in
    select c.conname, c.conrelid::regclass as tbl
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = any (c.conkey)
    where c.contype = 'c'
      and c.conrelid in ('public.ai_usage'::regclass, 'public.ai_explanation_requests'::regclass)
      and a.attname = 'provider'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table public.ai_usage
  add constraint ai_usage_provider_check
  check (provider is null or provider in ('anthropic', 'openai', 'openrouter'));

alter table public.ai_explanation_requests
  add constraint ai_explanation_requests_provider_check
  check (provider is null or provider in ('anthropic', 'openai', 'openrouter'));

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
  if p_provider not in ('anthropic', 'openai', 'openrouter')
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
