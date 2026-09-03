-- Transactional smoke test for the Phase 2 billing-operations migration.
-- Run only against a disposable/local database after the full migration chain.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'billing-one@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'billing-two@example.invalid');

insert into public.billing_customers (owner_id, provider_customer_id) values
  ('00000000-0000-4000-8000-000000000001', 'cus_local_one'),
  ('00000000-0000-4000-8000-000000000002', 'cus_local_two');

do $$
declare
  v_decision text;
begin
  v_decision := public.moxscore_claim_webhook_event('evt_local_one', 'customer.subscription.updated');
  if v_decision <> 'claimed' then raise exception 'first webhook claim was %', v_decision; end if;

  v_decision := public.moxscore_claim_webhook_event('evt_local_one', 'customer.subscription.updated');
  if v_decision <> 'retry_later' then raise exception 'live duplicate was %', v_decision; end if;

  perform public.moxscore_complete_webhook_event('evt_local_one', 'processed');
  v_decision := public.moxscore_claim_webhook_event('evt_local_one', 'customer.subscription.updated');
  if v_decision <> 'duplicate_processed' then raise exception 'completed duplicate was %', v_decision; end if;

  v_decision := public.moxscore_claim_webhook_event('evt_local_two', 'invoice.payment_failed');
  perform public.moxscore_complete_webhook_event('evt_local_two', 'failed');
  v_decision := public.moxscore_claim_webhook_event('evt_local_two', 'invoice.payment_failed');
  if v_decision <> 'claimed' then raise exception 'failed event reclaim was %', v_decision; end if;
end;
$$;

do $$
declare
  v_acquired boolean;
  v_cursor bigint;
  v_summary jsonb;
begin
  select acquired, start_cursor into v_acquired, v_cursor
  from public.moxscore_start_billing_reconciliation(
    '00000000-0000-4000-8000-000000000011', 'dry_run', 240
  );
  if not v_acquired or v_cursor <> 0 then raise exception 'first lease/cursor invalid'; end if;

  select acquired, start_cursor into v_acquired, v_cursor
  from public.moxscore_start_billing_reconciliation(
    '00000000-0000-4000-8000-000000000013', 'dry_run', 240
  );
  if v_acquired or v_cursor <> 0 then raise exception 'overlapping lease was not rejected'; end if;

  perform public.moxscore_finish_billing_reconciliation(
    '00000000-0000-4000-8000-000000000011', 'succeeded', 2, true,
    '{"processedCustomers": 2, "unresolved": 1}'::jsonb
  );

  select acquired, start_cursor into v_acquired, v_cursor
  from public.moxscore_start_billing_reconciliation(
    '00000000-0000-4000-8000-000000000012', 'repair', 240
  );
  if not v_acquired or v_cursor <> 2 then raise exception 'resumed lease/cursor invalid'; end if;

  perform public.moxscore_finish_billing_reconciliation(
    '00000000-0000-4000-8000-000000000012', 'succeeded', 0, false,
    '{"processedCustomers": 1, "repaired": 1}'::jsonb
  );

  v_summary := public.moxscore_billing_operations_summary(600);
  if (v_summary #>> '{last_counts,processedCustomers}')::integer <> 3
    or (v_summary #>> '{last_counts,unresolved}')::integer <> 1
    or (v_summary #>> '{last_counts,repaired}')::integer <> 1
    or v_summary->>'last_full_success_at' is null then
    raise exception 'reconciliation aggregate/cursor smoke failed: %', v_summary;
  end if;
end;
$$;

select public.moxscore_project_subscription(
  'sub_local_one', 'cus_local_one', '00000000-0000-4000-8000-000000000001',
  'pro_monthly', 'active', now() + interval '1 month', false, now()
);

select public.moxscore_set_owner_reconciliation_block(
  '00000000-0000-4000-8000-000000000001', true
);

select public.moxscore_project_subscription(
  'sub_local_blocked', 'cus_local_one', '00000000-0000-4000-8000-000000000001',
  'pro_monthly', 'active', now() + interval '1 month', false, now()
);

do $$
begin
  if not exists (
    select 1 from public.subscriptions
    where provider_subscription_id = 'sub_local_blocked'
      and reconciliation_blocked = true
  ) then raise exception 'owner block did not cover a concurrent projection'; end if;
end;
$$;

do $$
begin
  perform public.moxscore_project_subscription(
    'sub_local_one', 'cus_local_two', '00000000-0000-4000-8000-000000000002',
    'pro_monthly', 'active', now() + interval '1 month', false, now()
  );
  raise exception 'cross-owner webhook projection unexpectedly succeeded';
exception
  when sqlstate '55000' then null;
end;
$$;

do $$
begin
  perform public.moxscore_reconcile_subscription(
    'sub_local_one', 'cus_local_two', '00000000-0000-4000-8000-000000000002',
    'pro_monthly', 'active', now() + interval '1 month', false, now(), false
  );
  raise exception 'cross-owner reconciliation unexpectedly succeeded';
exception
  when sqlstate '55000' then null;
end;
$$;

do $$
begin
  if has_function_privilege(
    'service_role',
    'public.moxscore_project_subscription(text,uuid,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  ) then raise exception 'legacy projection overload remains executable'; end if;

  if not has_function_privilege(
    'service_role',
    'public.moxscore_project_subscription(text,text,uuid,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  ) then raise exception 'customer-aware projection overload is not executable'; end if;
end;
$$;

rollback;
