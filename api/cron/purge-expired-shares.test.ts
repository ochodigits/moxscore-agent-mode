import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from '../_routes/cron/purge-expired-shares'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

describe('expired-share cron', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('requires the configured cron capability before deleting rows', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    const { res, result } = createRes()
    await handler({ method: 'GET' }, res)
    expect(result).toEqual({ statusCode: 401, body: { error: 'Unauthorized' } })
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('purges only expired shares after authenticating the cron request', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const lt = vi.fn().mockResolvedValue({ error: null })
    const remove = vi.fn().mockReturnValue({ lt })
    const from = vi.fn().mockReturnValue({ delete: remove })
    const rpc = vi.fn()
    createClientMock.mockReturnValue({ from, rpc })
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res)

    expect(result).toEqual({ statusCode: 200, body: { ok: true, aiExplanationsPurged: 0 } })
    expect(from).toHaveBeenCalledWith('shared_decks')
    expect(lt).toHaveBeenCalledWith('expires_at', expect.any(String))
    expect(rpc).not.toHaveBeenCalled()
  })

  it('also runs bounded AI retention cleanup only when the Pro surface is enabled', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('MOXSCORE_ENABLE_PRO_AI', 'true')
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const lt = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ lt }) })
    const rpc = vi.fn().mockResolvedValue({ data: 7, error: null })
    createClientMock.mockReturnValue({ from, rpc })
    const { res, result } = createRes()

    await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res)

    expect(result).toEqual({ statusCode: 200, body: { ok: true, aiExplanationsPurged: 7 } })
    expect(rpc).toHaveBeenCalledWith('moxscore_prune_ai_explanations', { p_limit: 500 })
  })
})
