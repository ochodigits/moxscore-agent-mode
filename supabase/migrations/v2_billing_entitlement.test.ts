import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260815120000_v2_billing_entitlement.sql'),
  'utf8',
)

describe('v2 billing and entitlement migration', () => {
  it('creates the commercial control-plane tables', () => {
    expect(migration).toContain('create table if not exists public.billing_customers')
    expect(migration).toContain('create table if not exists public.subscriptions')
    expect(migration).toContain('create table if not exists public.webhook_events')
    expect(migration).toContain('create table if not exists public.ai_usage')
  })

  it('keeps billing data unreadable by every browser role', () => {
    for (const table of ['billing_customers', 'subscriptions', 'webhook_events', 'ai_usage']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`)
      expect(migration).toContain(`revoke all privileges on table public.${table} from public, anon, authenticated`)
    }
    // Unlike the Core tables, no browser select grant or read policy exists:
    // entitlement reaches the browser only as derived capability booleans.
    expect(migration).not.toContain('grant select on public.subscriptions to authenticated')
    expect(migration).not.toContain('create policy "subscriptions')
  })

  it('stores no raw webhook payload', () => {
    expect(migration).not.toContain('raw_payload')
    expect(migration).not.toContain('payload jsonb')
  })

  it('makes webhook processing idempotent on the provider event id', () => {
    expect(migration).toContain('provider_event_id text primary key')
    expect(migration).toContain('on conflict (provider_event_id) do nothing')
    expect(migration).toContain('create or replace function public.moxscore_record_webhook_event')
  })

  it('lets a failed or abandoned attempt be re-claimed on retry', () => {
    // Without this, one transient error would make Stripe's retry look like a
    // duplicate and the event would be dropped permanently.
    expect(migration).toContain("if v_result = 'failed' or (v_processed_at is null and v_received_at < now() - interval '5 minutes') then")
    expect(migration).toContain('set received_at = now(), processed_at = null, result = null')
  })

  it('rejects out-of-order subscription events by provider timestamp', () => {
    expect(migration).toContain('create or replace function public.moxscore_project_subscription')
    expect(migration).toContain('if existing_event_at is not null and existing_event_at > p_event_at then')
    expect(migration).toContain('pg_advisory_xact_lock')
  })

  it('consumes AI quota atomically and cannot double-charge a retry', () => {
    expect(migration).toContain('create or replace function public.moxscore_consume_ai_quota')
    expect(migration).toContain('request_id text primary key')
    expect(migration).toContain("return query select true, 'replay'::text")
    expect(migration).toContain("'monthly_limit'")
    expect(migration).toContain("'daily_limit'")
    expect(migration).toContain("'burst_limit'")
  })

  it('refunds a quota unit only when no provider request was charged', () => {
    expect(migration).toContain('create or replace function public.moxscore_refund_ai_quota')
    expect(migration).toContain('and input_tokens = 0')
    expect(migration).toContain('and estimated_cost_micros = 0')
  })

  it('can clear a deleted account billing projection without granting browser access', () => {
    expect(migration).toContain('create or replace function public.moxscore_delete_billing_owner')
    expect(migration).toContain('delete from public.subscriptions where owner_id = p_owner_id')
    expect(migration).toContain('delete from public.billing_customers where owner_id = p_owner_id')
  })

  it('keeps every control-plane function service-role-only and search-path pinned', () => {
    const functions = [
      'public.moxscore_record_webhook_event(text, text)',
      'public.moxscore_complete_webhook_event(text, text)',
      'public.moxscore_project_subscription(text, uuid, text, text, timestamptz, boolean, timestamptz)',
      'public.moxscore_delete_billing_owner(uuid)',
      'public.moxscore_consume_ai_quota(uuid, text, text, integer, integer, integer)',
      'public.moxscore_record_ai_cost(text, integer, integer, bigint)',
      'public.moxscore_refund_ai_quota(text)',
    ]
    for (const fn of functions) {
      expect(migration).toContain(`revoke all on function ${fn} from public, anon, authenticated`)
      expect(migration).toContain(`grant execute on function ${fn} to service_role`)
    }
    expect(migration).not.toContain('security invoker')
    // Every definer function pins search_path; count them to catch a new one
    // being added without it.
    const definers = migration.match(/security definer/g) ?? []
    const pinned = migration.match(/set search_path = ''/g) ?? []
    expect(pinned.length).toBe(definers.length)
  })

  it('routes subscription and usage writes through functions, not table grants', () => {
    expect(migration).toContain('grant select on public.subscriptions to service_role')
    expect(migration).toContain('grant select on public.ai_usage to service_role')
    expect(migration).not.toContain('grant select, insert, update, delete on public.subscriptions to service_role')
  })
})
