import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260731210542_v2_shared_deck_retention.sql'), 'utf8')

describe('v2 shared deck retention migration', () => {
  it('adds expiry and opaque-token storage without reopening browser access', () => {
    expect(migration).toMatch(/add column if not exists expires_at timestamptz/i)
    expect(migration).toMatch(/created_at \+ interval '90 days'/i)
    expect(migration).toMatch(/add column if not exists deletion_token_hash text/i)
    expect(migration).toMatch(/revoke all privileges on table public\.shared_decks from service_role/i)
    expect(migration).toMatch(/grant select, insert, delete on table public\.shared_decks to service_role/i)
    expect(migration).not.toMatch(/grant .* to (anon|authenticated|public)/i)
  })
})
