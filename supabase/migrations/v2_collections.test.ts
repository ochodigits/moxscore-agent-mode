import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20260731204954_v2_collections.sql'), 'utf8')

describe('v2 collection migration', () => {
  it('stores one normalized collection per owner and no raw import file', () => {
    expect(migration).toContain('owner_id uuid not null unique')
    expect(migration).toContain('primary key (collection_id, normalized_name)')
    expect(migration).not.toContain('raw_csv')
    expect(migration).not.toContain('raw_file')
  })

  it('uses RLS and a service-role-only atomic replace function', () => {
    expect(migration).toContain('alter table public.collections enable row level security')
    expect(migration).toContain('alter table public.collection_cards enable row level security')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('security definer')
    expect(migration).toContain('grant execute on function public.moxscore_replace_collection')
  })
})
