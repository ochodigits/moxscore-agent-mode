import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260823120000_v2_billing_operations.sql'),
  'utf8',
)

describe('v2 billing operations migration', () => {
  it('adds a keyset cursor and a fail-closed reconciliation marker', () => {
    expect(migration).toContain('reconciliation_key bigint generated always as identity')
    expect(migration).toContain('billing_customers_reconciliation_key_idx')
    expect(migration).toContain('reconciliation_blocked boolean not null default false')
    expect(migration).toContain('reconciliation_blocked boolean not null default false')
  })

  it('distinguishes completed duplicates from live webhook leases', () => {
    expect(migration).toContain('create or replace function public.moxscore_claim_webhook_event')
    expect(migration).toContain("return 'duplicate_processed'")
    expect(migration).toContain("return 'retry_later'")
    expect(migration).toContain("return 'claimed'")
  })

  it('uses short durable lease transactions and resumable keyset state', () => {
    expect(migration).toContain('create table if not exists public.billing_reconciliation_state')
    expect(migration).toContain('next_customer_key bigint not null default 0')
    expect(migration).toContain('lease_expires_at')
    expect(migration).toContain('create or replace function public.moxscore_start_billing_reconciliation')
    expect(migration).toContain('create or replace function public.moxscore_finish_billing_reconciliation')
    expect(migration).toContain("cycle_counts jsonb not null default '{}'::jsonb")
    expect(migration).toContain('last_counts = v_cycle_counts')
  })

  it('checks the exact server-owned customer and prevents subscription owner rebinding', () => {
    expect(migration).toContain('where provider_customer_id = btrim(p_customer_id)')
    expect(migration).toContain("raise exception 'Billing ownership mismatch'")
    expect(migration).toContain("raise exception 'Subscription ownership mismatch'")
    expect(migration).toContain('set reconciliation_blocked = p_blocked')
    expect(migration).toContain('v_mapping_blocked')
    expect(migration).not.toContain('on conflict (provider_subscription_id) do update set\n    owner_id = excluded.owner_id')
  })

  it('stores aggregate reports but no raw provider payload or owner identifier in run records', () => {
    const runTable = migration.slice(
      migration.indexOf('create table if not exists public.billing_reconciliation_runs'),
      migration.indexOf('create index if not exists billing_reconciliation_runs_started_idx'),
    )
    expect(runTable).toContain('counts jsonb')
    expect(runTable).not.toContain('owner_id')
    expect(runTable).not.toContain('provider_customer_id')
    expect(runTable).not.toContain('provider_subscription_id')
    expect(migration).not.toContain('raw_payload')
  })

  it('keeps operations tables and functions service-role-only', () => {
    for (const table of ['billing_reconciliation_state', 'billing_reconciliation_runs']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`)
      expect(migration).toContain(`revoke all privileges on table public.${table} from public, anon, authenticated`)
    }
    const functions = [
      'public.moxscore_claim_webhook_event(text, text)',
      'public.moxscore_start_billing_reconciliation(text, text, integer)',
      'public.moxscore_finish_billing_reconciliation(text, text, bigint, boolean, jsonb)',
      'public.moxscore_project_subscription(text, text, uuid, text, text, timestamptz, boolean, timestamptz)',
      'public.moxscore_reconcile_subscription(text, text, uuid, text, text, timestamptz, boolean, timestamptz, boolean)',
      'public.moxscore_set_owner_reconciliation_block(uuid, boolean)',
      'public.moxscore_billing_operations_summary(integer)',
    ]
    for (const fn of functions) {
      expect(migration).toContain(`revoke all on function ${fn} from public, anon, authenticated`)
      expect(migration).toContain(`grant execute on function ${fn} to service_role`)
    }
  })

  it('pins every definer function search path', () => {
    expect(migration.match(/security definer/g)?.length).toBe(migration.match(/set search_path = ''/g)?.length)
  })
})
