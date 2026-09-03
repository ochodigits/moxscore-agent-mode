import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260823150000_v2_pro_ai_controls.sql'),
  'utf8',
)

describe('v2 constrained Pro AI migration', () => {
  it('binds replay to the exact owner, request id, input hash, and contract versions', () => {
    expect(migration).toContain('create table if not exists public.ai_explanation_requests')
    expect(migration).toContain('input_hash text not null')
    expect(migration).toContain('request_schema_version text not null')
    expect(migration).toContain('prompt_version text not null')
    expect(migration).toContain("return query select 'request_conflict'::text")
    expect(migration).toContain("return query select 'ambiguous_provider'::text")
    expect(migration).toContain("if v_reason = 'replay' then")
  })

  it('keeps quota, provider contact, spend reservation, and concurrency durable', () => {
    expect(migration).toContain("p_operation <> 'tune_explanation'")
    expect(migration).toContain('create table if not exists public.ai_provider_leases')
    expect(migration).toContain("hashtext('moxscore:ai-provider-capacity')")
    expect(migration).toContain('and leases.lease_expires_at > now()')
    expect(migration).toContain('estimated_cost_micros = leases.reservation_micros')
    expect(migration).toContain('and usage.provider_contacted = false')
    expect(migration).toContain("where request_id = btrim(p_request_id) and provider_contacted = true")
  })

  it('refunds only provably uncontacted work and retains ambiguous calls', () => {
    const refund = migration.slice(
      migration.indexOf('create or replace function public.moxscore_refund_ai_quota'),
      migration.indexOf('create or replace function public.moxscore_record_ai_metric'),
    )
    expect(refund).toContain('provider_contacted = false')
    expect(refund).toContain('input_tokens = 0')
    expect(refund).not.toContain('provider_contacted = true')
  })

  it('stores only aggregate operations metrics and bounded feedback', () => {
    const metricsTable = migration.slice(
      migration.indexOf('create table if not exists public.ai_operation_metrics'),
      migration.indexOf('create table if not exists public.ai_explanation_feedback'),
    )
    expect(metricsTable).not.toMatch(/owner_id|request_id|prompt|card|deck|model|provider text/)
    expect(migration).toContain("rating in ('up', 'down')")
    expect(migration).toContain("'helpful', 'irrelevant', 'unclear', 'unsupported', 'too_generic'")
    expect(migration).toContain('latency_sample_count + excluded.latency_sample_count')
  })

  it('enforces response retention and deletion cascades', () => {
    expect(migration).toContain("expires_at timestamptz not null default (now() + interval '35 days')")
    expect(migration).toContain('create or replace function public.moxscore_prune_ai_explanations')
    expect(migration).toContain('limit p_limit')
    expect(migration).toContain('for update skip locked')
    expect(migration.match(/references auth\.users\(id\) on delete cascade/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps every control table and definer function service-only', () => {
    for (const table of ['ai_explanation_requests', 'ai_provider_leases', 'ai_operation_metrics', 'ai_explanation_feedback']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`)
      expect(migration).toContain(`revoke all privileges on table public.${table} from public, anon, authenticated, service_role`)
    }
    expect(migration).toContain('grant execute on function public.moxscore_prune_ai_explanations(integer) to service_role')
    expect(migration.match(/security definer/g)?.length).toBe(migration.match(/set search_path = ''/g)?.length)
  })
})
