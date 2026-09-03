import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(import.meta.dirname, '20260818120000_v2_pro_saved_deck_limits.sql'),
  'utf8',
)

describe('v2 Pro saved deck limits migration', () => {
  it('accepts only the free and Pro deck ceilings', () => {
    expect(migration).toContain('p_limit not in (10, 100)')
    expect(migration).toContain('saved_count >= p_limit')
  })

  it('keeps the function security-definer with an empty search_path', () => {
    expect(migration).toContain('security definer')
    expect(migration).toContain("set search_path = ''")
  })
})
