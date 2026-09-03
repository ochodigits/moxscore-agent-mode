import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/account-export'

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

describe('/api/account-export', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('fails closed before optional persistence is explicitly enabled', async () => {
    const { res, result } = createRes()
    await handler({ method: 'GET' }, res)
    expect(result).toEqual({ statusCode: 404, body: { error: 'Not available' } })
  })

  it('exports only decks first proven to belong to the verified requester', async () => {
    enablePersistence()
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    const versionOrderFinal = vi.fn().mockResolvedValue({ data: [{ id: 'version-1', deck_id: 'deck-1', decklist: '1 Sol Ring' }], error: null })
    const versionOrder = vi.fn().mockReturnValue({ order: versionOrderFinal })
    const deckOrder = vi.fn().mockResolvedValue({ data: [{ id: 'deck-1', name: 'Owned deck' }], error: null })
    const ownerEq = vi.fn().mockReturnValue({ order: deckOrder })
    const versionIn = vi.fn().mockReturnValue({ order: versionOrder })
    const from = vi.fn((table: string) => {
      if (table === 'saved_decks') return { select: vi.fn().mockReturnValue({ eq: ownerEq }) }
      if (table === 'deck_versions') return { select: vi.fn().mockReturnValue({ in: versionIn }) }
      throw new Error(`Unexpected table ${table}`)
    })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ from })
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual(expect.objectContaining({
      profile: { id: 'verified-user' },
      saved_decks: [{ id: 'deck-1', name: 'Owned deck' }],
      deck_versions: [{ id: 'version-1', deck_id: 'deck-1', decklist: '1 Sol Ring' }],
      collection: null,
      collection_cards: [],
    }))
    expect(ownerEq).toHaveBeenCalledWith('owner_id', 'verified-user')
    expect(versionIn).toHaveBeenCalledWith('deck_id', ['deck-1'])
  })
})
