import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/deck-version'

const DECK_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

describe('/api/deck-version', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('accepts only a bounded valid immutable snapshot after identity verification', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_PERSISTENCE', 'true')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'version-1', version_number: 1 }, error: null })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ rpc })
    const { res, result } = createRes()

    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer verified-token' },
      body: JSON.stringify({
        deckId: DECK_ID,
        decklist: '1 Sol Ring',
        analysisSnapshot: { score: 80 },
        analyzerVersion: 'v2.0.0',
        curatedDataVersion: '2026-07-31',
      }),
    }, res)

    expect(result).toEqual({ statusCode: 201, body: { version: { id: 'version-1', version_number: 1 } } })
    expect(rpc).toHaveBeenCalledWith('moxscore_create_deck_version', expect.objectContaining({
      p_owner_id: 'verified-user', p_deck_id: DECK_ID, p_limit: 20,
    }))
  })

  it('rejects invalid deck ids before any database operation', async () => {
    const { res, result } = createRes()
    await handler({ method: 'POST', body: JSON.stringify({ deckId: 'not-a-uuid' }) }, res)
    expect(result.statusCode).toBe(404)
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('lists immutable versions only after confirming that the deck belongs to the verified user', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_PERSISTENCE', 'true')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    const ownedMaybeSingle = vi.fn().mockResolvedValue({ data: { id: DECK_ID }, error: null })
    const ownerEq = vi.fn().mockReturnValue({ maybeSingle: ownedMaybeSingle })
    const idEq = vi.fn().mockReturnValue({ eq: ownerEq })
    const ownedSelect = vi.fn().mockReturnValue({ eq: idEq })
    const order = vi.fn().mockResolvedValue({ data: [{ id: 'version-2', version_number: 2 }], error: null })
    const versionEq = vi.fn().mockReturnValue({ order })
    const versionSelect = vi.fn().mockReturnValue({ eq: versionEq })
    const from = vi.fn((table: string) => table === 'saved_decks'
      ? { select: ownedSelect }
      : { select: versionSelect })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ from })
    const { res, result } = createRes()

    await handler({ method: 'GET', query: { deckId: DECK_ID }, headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result).toEqual({ statusCode: 200, body: { versions: [{ id: 'version-2', version_number: 2 }] } })
    expect(ownerEq).toHaveBeenCalledWith('owner_id', 'verified-user')
    expect(versionEq).toHaveBeenCalledWith('deck_id', DECK_ID)
  })
})
