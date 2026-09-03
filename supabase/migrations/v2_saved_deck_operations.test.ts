import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260731203930_v2_saved_deck_operations.sql'),
  'utf8',
)

describe('v2 saved-deck operation migration', () => {
  it('makes limit enforcement atomic with an owner or deck lock', () => {
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('for update')
    expect(migration).toContain("raise exception 'Saved deck limit reached'")
    expect(migration).toContain("raise exception 'Deck version limit reached'")
  })

  it('restricts privileged functions to the service role', () => {
    expect(migration).toContain('security definer')
    expect(migration).toContain('set search_path = public, pg_temp')
    expect(migration).toContain('revoke all on function public.moxscore_create_saved_deck')
    expect(migration).toContain('grant execute on function public.moxscore_create_deck_version')
  })
})
