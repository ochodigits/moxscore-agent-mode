-- Transactional smoke test for constrained Pro AI controls.
-- Run only after the full migration chain in a disposable/local database.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000101', 'ai-one@example.invalid'),
  ('00000000-0000-4000-8000-000000000102', 'ai-two@example.invalid'),
  ('00000000-0000-4000-8000-000000000103', 'ai-limits@example.invalid');

do $$
declare
  v_decision text;
  v_month integer;
  v_cached jsonb;
  v_allowed boolean;
  v_reason text;
begin
  select decision, month_used into v_decision, v_month
  from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000101',
    '123e4567-e89b-42d3-a456-426614174101', repeat('a', 64),
    'moxscore.tune-explanations.request.v1', 'tune-explanations.2026-08-23.v1',
    50, 10, 5, 90
  );
  if v_decision <> 'acquired' or v_month <> 1 then raise exception 'first claim invalid: %, %', v_decision, v_month; end if;

  select decision into v_decision
  from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000101',
    '123e4567-e89b-42d3-a456-426614174101', repeat('a', 64),
    'moxscore.tune-explanations.request.v1', 'tune-explanations.2026-08-23.v1',
    50, 10, 5, 90
  );
  if v_decision <> 'in_progress' then raise exception 'live replay invalid: %', v_decision; end if;

  select decision into v_decision
  from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000102',
    '123e4567-e89b-42d3-a456-426614174101', repeat('a', 64),
    'moxscore.tune-explanations.request.v1', 'tune-explanations.2026-08-23.v1',
    50, 10, 5, 90
  );
  if v_decision <> 'request_conflict' then raise exception 'cross-owner replay invalid: %', v_decision; end if;

  select decision into v_decision
  from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000101',
    '123e4567-e89b-42d3-a456-426614174101', repeat('b', 64),
    'moxscore.tune-explanations.request.v1', 'tune-explanations.2026-08-23.v1',
    50, 10, 5, 90
  );
  if v_decision <> 'request_conflict' then raise exception 'input conflict invalid: %', v_decision; end if;

  select allowed, reason into v_allowed, v_reason
  from public.moxscore_reserve_ai_provider_capacity(
    '123e4567-e89b-42d3-a456-426614174101', 100000, 1000000, 1, 10000, 60
  );
  if not v_allowed or v_reason <> 'granted' then raise exception 'capacity grant invalid: %, %', v_allowed, v_reason; end if;

  if not public.moxscore_mark_ai_provider_contacted(
    '123e4567-e89b-42d3-a456-426614174101', 'openai', 'approved-model-v1'
  ) then raise exception 'provider marker failed'; end if;

  if (select estimated_cost_micros from public.ai_usage where request_id = '123e4567-e89b-42d3-a456-426614174101') <> 10000 then
    raise exception 'conservative spend was not persisted before provider contact';
  end if;

  perform public.moxscore_refund_ai_quota('123e4567-e89b-42d3-a456-426614174101');
  if not exists (select 1 from public.ai_usage where request_id = '123e4567-e89b-42d3-a456-426614174101') then
    raise exception 'contacted provider usage was incorrectly refunded';
  end if;

  perform public.moxscore_record_ai_cost('123e4567-e89b-42d3-a456-426614174101', 100, 20, 360);
  perform public.moxscore_complete_ai_explanation(
    '123e4567-e89b-42d3-a456-426614174101',
    '{"schemaVersion":"moxscore.tune-explanations.response.v1","promptVersion":"tune-explanations.2026-08-23.v1","explanations":[],"providerOutcome":"success"}'::jsonb,
    'success', 250
  );

  select decision, cached_response into v_decision, v_cached
  from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000101',
    '123e4567-e89b-42d3-a456-426614174101', repeat('a', 64),
    'moxscore.tune-explanations.request.v1', 'tune-explanations.2026-08-23.v1',
    50, 10, 5, 90
  );
  if v_decision <> 'completed' or v_cached is null then raise exception 'completed replay invalid: %', v_decision; end if;
end;
$$;

do $$
declare
  v_index integer;
  v_decision text;
  v_request_id text;
begin
  -- Five live claims in one minute are allowed; the sixth hits the exact
  -- per-minute ceiling before a provider lease is reserved.
  for v_index in 1..5 loop
    v_request_id := '123e4567-e89b-42d3-a456-' || lpad((426614175000 + v_index)::text, 12, '0');
    select decision into v_decision from public.moxscore_claim_ai_explanation(
      '00000000-0000-4000-8000-000000000103', v_request_id, repeat('f', 64),
      'v1', 'p1', 50, 10, 5, 90
    );
    if v_decision <> 'acquired' then raise exception 'minute setup claim % was %', v_index, v_decision; end if;
  end loop;
  select decision into v_decision from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000103', '123e4567-e89b-42d3-a456-426614175006', repeat('f', 64),
    'v1', 'p1', 50, 10, 5, 90
  );
  if v_decision <> 'burst_limit' then raise exception 'minute ceiling was %', v_decision; end if;

  update public.ai_usage set created_at = now() - interval '2 minutes'
  where owner_id = '00000000-0000-4000-8000-000000000103';
  for v_index in 6..10 loop
    v_request_id := '123e4567-e89b-42d3-a456-' || lpad((426614175000 + v_index)::text, 12, '0');
    select decision into v_decision from public.moxscore_claim_ai_explanation(
      '00000000-0000-4000-8000-000000000103', v_request_id, repeat('f', 64),
      'v1', 'p1', 50, 10, 5, 90
    );
    if v_decision <> 'acquired' then raise exception 'daily setup claim % was %', v_index, v_decision; end if;
  end loop;
  select decision into v_decision from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000103', '123e4567-e89b-42d3-a456-426614175011', repeat('f', 64),
    'v1', 'p1', 50, 10, 5, 90
  );
  if v_decision <> 'daily_limit' then raise exception 'daily ceiling was %', v_decision; end if;
end;
$$;

do $$
declare
  v_decision text;
  v_allowed boolean;
  v_reason text;
begin
  select decision into v_decision from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000101',
    '123e4567-e89b-42d3-a456-426614174102', repeat('c', 64), 'v1', 'p1', 50, 10, 5, 90
  );
  select allowed, reason into v_allowed, v_reason from public.moxscore_reserve_ai_provider_capacity(
    '123e4567-e89b-42d3-a456-426614174102', 100000, 1000000, 1, 10000, 60
  );
  if not v_allowed then raise exception 'second capacity should start after released lease'; end if;

  select decision into v_decision from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000102',
    '123e4567-e89b-42d3-a456-426614174103', repeat('d', 64), 'v1', 'p1', 50, 10, 5, 90
  );
  select allowed, reason into v_allowed, v_reason from public.moxscore_reserve_ai_provider_capacity(
    '123e4567-e89b-42d3-a456-426614174103', 100000, 1000000, 1, 10000, 60
  );
  if v_allowed or v_reason <> 'concurrency' then raise exception 'concurrency denial invalid: %, %', v_allowed, v_reason; end if;

  perform public.moxscore_refund_ai_quota('123e4567-e89b-42d3-a456-426614174103');
  if exists (select 1 from public.ai_usage where request_id = '123e4567-e89b-42d3-a456-426614174103') then
    raise exception 'pre-provider refund did not remove quota';
  end if;
end;
$$;

do $$
declare
  v_summary jsonb;
begin
  perform public.moxscore_record_ai_feedback(
    '00000000-0000-4000-8000-000000000101',
    '123e4567-e89b-42d3-a456-426614174101', 'up', 'helpful'
  );
  begin
    perform public.moxscore_record_ai_feedback(
      '00000000-0000-4000-8000-000000000102',
      '123e4567-e89b-42d3-a456-426614174101', 'down', 'unsupported'
    );
    raise exception 'cross-owner feedback unexpectedly succeeded';
  exception when sqlstate 'P0002' then null;
  end;

  v_summary := public.moxscore_ai_operations_summary();
  if (v_summary #>> '{today,provider_call_count}')::integer <> 1
    or (v_summary #>> '{today,estimated_cost_micros}')::integer <> 360
    or (v_summary #>> '{today,latency_sample_count}')::integer <> 1 then
    raise exception 'aggregate metrics invalid: %', v_summary;
  end if;
  if v_summary::text ~ '(00000000-0000|123e4567|Cancel|Arcane)' then
    raise exception 'aggregate summary leaked an identifier or card name';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('authenticated', 'public.moxscore_claim_ai_explanation(uuid,text,text,text,text,integer,integer,integer,integer)', 'EXECUTE') then
    raise exception 'authenticated can execute AI claim';
  end if;
  if not has_function_privilege('service_role', 'public.moxscore_prune_ai_explanations(integer)', 'EXECUTE') then
    raise exception 'service role cannot execute bounded AI retention cleanup';
  end if;
end;
$$;

do $$
declare
  v_decision text;
  v_allowed boolean;
  v_reason text;
begin
  -- Spend blocks at 100% before a provider marker can be written.
  select decision into v_decision from public.moxscore_claim_ai_explanation(
    '00000000-0000-4000-8000-000000000102',
    '123e4567-e89b-42d3-a456-426614174104', repeat('e', 64), 'v1', 'p1', 50, 10, 5, 90
  );
  select allowed, reason into v_allowed, v_reason from public.moxscore_reserve_ai_provider_capacity(
    '123e4567-e89b-42d3-a456-426614174104', 10000, 1000000, 2, 10000, 60
  );
  if v_allowed or v_reason <> 'daily_budget' then raise exception '100 percent budget denial invalid: %, %', v_allowed, v_reason; end if;
  perform public.moxscore_refund_ai_quota('123e4567-e89b-42d3-a456-426614174104');
end;
$$;

do $$
declare
  v_pruned integer;
begin
  update public.ai_explanation_requests
  set expires_at = now() - interval '1 second'
  where request_id = '123e4567-e89b-42d3-a456-426614174101';
  v_pruned := public.moxscore_prune_ai_explanations(10);
  if v_pruned <> 1 then raise exception 'retention prune count invalid: %', v_pruned; end if;
  if exists (select 1 from public.ai_usage where request_id = '123e4567-e89b-42d3-a456-426614174101')
    or exists (select 1 from public.ai_explanation_feedback where request_id = '123e4567-e89b-42d3-a456-426614174101') then
    raise exception 'retention deletion did not cascade';
  end if;
  if not exists (select 1 from public.ai_operation_metrics) then
    raise exception 'anonymous aggregate metrics were incorrectly deleted';
  end if;
end;
$$;

rollback;
