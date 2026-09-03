import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/deck-item'

const DECK_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

function enablePersistence() {
  vi.stubEnv('VERCEL_ENV', 'preview')
  vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
  vi.stubEnv('MOXSCORE_ENABLE_PERSISTENCE', 'true')
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
}

describe('/api/deck-item', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('filters a single saved deck by both id and verified owner', async () => {
    enablePersistence()
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: DECK_ID, name: 'My Deck' }, error: null })
    const ownerEq = vi.fn().mockReturnValue({ maybeSingle })
    const idEq = vi.fn().mockReturnValue({ eq: ownerEq })
    const select = vi.fn().mockReturnValue({ eq: idEq })
    const from = vi.fn().mockReturnValue({ select })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ from })
    const { res, result } = createRes()

    await handler({ method: 'GET', query: { id: DECK_ID }, headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result).toEqual({ statusCode: 200, body: { deck: { id: DECK_ID, name: 'My Deck' } } })
    expect(idEq).toHaveBeenCalledWith('id', DECK_ID)
    expect(ownerEq).toHaveBeenCalledWith('owner_id', 'verified-user')
  })

  it('rejects a malformed id before querying a saved deck', async () => {
    enablePersistence()
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ from: vi.fn() })
    const { res, result } = createRes()

    await handler({ method: 'GET', query: { id: 'not-a-uuid' }, headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result).toEqual({ statusCode: 400, body: { error: 'Invalid saved deck id' } })
  })
})
