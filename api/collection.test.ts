import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/collection'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

function enableCollections() {
  vi.stubEnv('VERCEL_ENV', 'preview')
  vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
  vi.stubEnv('MOXSCORE_ENABLE_COLLECTIONS', 'true')
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
}

describe('/api/collection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('fails closed until the collection flag is deliberately enabled', async () => {
    const { res, result } = createRes()
    await handler({ method: 'GET' }, res)
    expect(result).toEqual({ statusCode: 404, body: { error: 'Not available' } })
  })

  it('replaces only normalized cards for the verified owner', async () => {
    enableCollections()
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null })
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'collection-1' }, error: null })
    createClientMock.mockReturnValueOnce({ auth: { getUser } }).mockReturnValueOnce({ rpc })
    const { res, result } = createRes()
    await handler({
      method: 'PUT',
      headers: { authorization: 'Bearer verified-token' },
      body: JSON.stringify({
        source: 'text', cards: [{ name: 'Sol Ring', quantity: 1 }], importSummary: { rows: 1, errors: 0, cards: 1, rawCsv: 'secret' }, ownerId: 'forged-user', rawCsv: 'secret',
      }),
    }, res)
    expect(result).toEqual({ statusCode: 200, body: { collection: { id: 'collection-1' } } })
    expect(rpc).toHaveBeenCalledWith('moxscore_replace_collection', expect.objectContaining({
      p_owner_id: 'verified-user', p_source_type: 'text', p_cards: [{ name: 'Sol Ring', quantity: 1, unresolved: true }],
      p_import_summary: { rows: 1, errors: 0, cards: 1 },
    }))
  })
})
