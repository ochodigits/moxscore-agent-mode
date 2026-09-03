import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260731203113_v2_owner_scoped_foundation.sql'),
  'utf8',
)

describe('v2 owner-scoped foundation migration', () => {
  it('creates the optional account and immutable deck-version records with a strict decklist limit', () => {
    expect(migration).toContain('create table if not exists public.profiles')
    expect(migration).toContain('create table if not exists public.saved_decks')
    expect(migration).toContain('create table if not exists public.deck_versions')
    expect(migration).toContain('octet_length(decklist) between 1 and 20000')
    expect(migration).toContain('unique (deck_id, version_number)')
  })

  it('enables RLS and makes every browser policy owner-scoped', () => {
    expect(migration).toContain('alter table public.profiles enable row level security')
    expect(migration).toContain('alter table public.saved_decks enable row level security')
    expect(migration).toContain('alter table public.deck_versions enable row level security')
    expect(migration).toContain('(select auth.uid()) = owner_id')
    expect(migration).toContain('saved_decks.owner_id = (select auth.uid())')
  })

  it('does not grant client roles access to billing-style fields or immutable version writes', () => {
    expect(migration).toContain('grant update (display_name, locale)')
    expect(migration).not.toContain('grant update on public.profiles to authenticated')
    expect(migration).toContain('grant select on public.deck_versions to authenticated')
    expect(migration).not.toContain('grant insert on public.deck_versions to authenticated')
    expect(migration).not.toContain('grant select, insert on public.saved_decks to authenticated')
  })
})
