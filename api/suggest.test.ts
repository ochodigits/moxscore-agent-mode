import { afterEach, describe, expect, it, vi } from 'vitest'

import handler from './_routes/suggest'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = {
    status(code: number) { result.statusCode = code; return res },
    json(body: unknown) { result.body = body },
  }
  return { res, result }
}

describe('/api/suggest retirement guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each(['preview', 'production'])('is unconditionally absent in %s', async (environment) => {
    vi.stubEnv('VERCEL_ENV', environment)
    vi.stubEnv('MOXSCORE_ENABLE_DEFERRED_AI', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_AI_PROVIDER_CALLS', 'true')
    vi.stubEnv('AI_PROVIDER', 'openai')
    vi.stubEnv('AI_MODEL', 'explicit-model')
    vi.stubEnv('AI_PROVIDER_API_KEY', 'secret')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { res, result } = createRes()

    await handler({ method: 'POST', body: { decklist: '1 Sol Ring' }, headers: {} }, res)

    expect(result).toEqual({ statusCode: 404, body: { error: 'Not available' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not expose a method-dependent response', async () => {
    const { res, result } = createRes()
    await handler({ method: 'GET', headers: {} }, res)
    expect(result.statusCode).toBe(404)
  })
})
