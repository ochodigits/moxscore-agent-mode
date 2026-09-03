import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/health'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

describe('/api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetAllMocks()
  })

  it('reports available third-party paths without user data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { 'x-forwarded-for': '198.51.100.20' } }, res)

    expect(result).toEqual({
      statusCode: 200,
      body: { status: 'ok', checks: { app: 'ok', scryfall: 'ok', combo_proxy: 'ok', sharing_storage: 'unconfigured' } },
    })
  })

  it('returns a retryable state when a required upstream path is degraded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValueOnce({ status: 405 }))
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { 'x-forwarded-for': '198.51.100.21' } }, res)

    expect(result).toEqual(expect.objectContaining({
      statusCode: 503,
      body: expect.objectContaining({ status: 'degraded', checks: expect.objectContaining({ scryfall: 'degraded', combo_proxy: 'ok' }) }),
    }))
  })

  it('checks the configured sharing store without returning credentials', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
    const limit = vi.fn().mockResolvedValue({ error: null })
    createClientMock.mockReturnValue({ from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ limit }) }) })
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { 'x-forwarded-for': '198.51.100.22' } }, res)

    expect(result).toEqual(expect.objectContaining({ body: expect.objectContaining({ checks: expect.objectContaining({ sharing_storage: 'ok' }) }) }))
  })
})
