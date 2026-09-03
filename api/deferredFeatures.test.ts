import { afterEach, describe, expect, it, vi } from 'vitest'

const completeMock = vi.fn()
vi.mock('./_ai.ts', () => ({
  complete: (...args: unknown[]) => completeMock(...args),
  aiProviderConfiguration: () => null,
}))

import podHandler from './_routes/pod'
import tuneHandler from './_routes/tune'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = {
    status(code: number) {
      result.statusCode = code
      return res
    },
    json(body: unknown) {
      result.body = body
    },
  }
  return { res, result }
}

describe('deferred v1 API surfaces', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    completeMock.mockReset()
  })

  it('keeps the tuner unavailable in production even if its flag is set', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('MOXSCORE_ENABLE_DEFERRED_AI', 'true')
    const { res, result } = createRes()

    await tuneHandler({ method: 'POST', body: JSON.stringify({ pairs: [{ cut: 'A', add: 'B' }] }) }, res)

    expect(result.statusCode).toBe(404)
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('keeps pod reads and writes unavailable by default', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('MOXSCORE_ENABLE_DEFERRED_POD', '')
    const { res, result } = createRes()

    await podHandler({ method: 'GET', query: { id: 'aaaaaaaa' } }, res)

    expect(result.statusCode).toBe(404)
  })
})
