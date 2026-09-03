import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/decks'

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

describe('/api/decks', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('fails closed before the persistence flag is enabled', async () => {
    const { res, result } = createRes()
    await handler({ method: 'GET' }, res)
    expect(result).toEqual({ statusCode: 404, body: { error: 'Not available' } })
  })

  it('creates decks with the verified server user, not a supplied owner id', async () => {
    enablePersistence()
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user', email: 'player@example.com' } }, error: null })
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'deck-1', name: 'My Deck' }, error: null })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ rpc })
    const { res, result } = createRes()

    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer verified-token' },
      body: JSON.stringify({ name: '  My Deck  ', ownerId: 'forged-user' }),
    }, res)

    expect(result).toEqual({ statusCode: 201, body: { deck: { id: 'deck-1', name: 'My Deck' } } })
    expect(rpc).toHaveBeenCalledWith('moxscore_create_saved_deck', expect.objectContaining({
      p_owner_id: 'verified-user', p_name: 'My Deck', p_limit: 10,
    }))
  })

  it('uses the Pro saved-deck ceiling from entitlement when billing grants Pro', async () => {
    enablePersistence()
    vi.stubEnv('MOXSCORE_ENABLE_BILLING', 'true')
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user', email: 'player@example.com' } }, error: null })
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'deck-2', name: 'Pro Deck' }, error: null })
    const maybeSingle = vi.fn()
    const eq = vi.fn().mockResolvedValue({
      data: [{
        status: 'active',
        price_key: 'pro_monthly',
        current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
        cancel_at_period_end: false,
      }],
      error: null,
    })
    const select = vi.fn().mockReturnValue({ eq })
    const from = vi.fn().mockReturnValue({ select, maybeSingle })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ rpc, from })
    const { res, result } = createRes()

    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer verified-token' },
      body: JSON.stringify({ name: 'Pro Deck' }),
    }, res)

    expect(result.statusCode).toBe(201)
    expect(rpc).toHaveBeenCalledWith('moxscore_create_saved_deck', expect.objectContaining({
      p_owner_id: 'verified-user', p_limit: 100,
    }))
  })

  it('returns a bounded list scoped to the verified owner', async () => {
    enablePersistence()
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    const order = vi.fn().mockResolvedValue({ data: [{ id: 'deck-1', name: 'My Deck' }], error: null })
    const eq = vi.fn().mockReturnValue({ order })
    const select = vi.fn().mockReturnValue({ eq })
    const from = vi.fn().mockReturnValue({ select })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ from })
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result).toEqual({ statusCode: 200, body: { decks: [{ id: 'deck-1', name: 'My Deck' }] } })
    expect(eq).toHaveBeenCalledWith('owner_id', 'verified-user')
  })
})
