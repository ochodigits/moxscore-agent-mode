import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260821213000_v2_saved_decks_current_version_index.sql'),
  'utf8',
)

describe('saved deck current-version foreign-key index', () => {
  it('covers the non-null current_version_id values used by the foreign key', () => {
    expect(migration).toContain('create index if not exists saved_decks_current_version_idx')
    expect(migration).toContain('on public.saved_decks (current_version_id)')
    expect(migration).toContain('where current_version_id is not null')
  })
})
