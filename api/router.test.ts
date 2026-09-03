import { afterEach, describe, expect, it, vi } from 'vitest'
import handler from './[...path]'

describe('API correlation boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('adds a generated correlation id to safe errors and response headers', async () => {
    const result: { statusCode: number; headers: Record<string, string>; body: unknown } = { statusCode: 0, headers: {}, body: null }
    const res = {
      status(code: number) { result.statusCode = code; return res },
      json(body: unknown) { result.body = body },
      setHeader(key: string, value: string) { result.headers[key] = value },
      send() {},
    }
    await handler({ url: '/api/not-a-route', query: {}, headers: {} }, res)
    expect(result.statusCode).toBe(404)
    expect(result.headers['X-Request-ID']).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.body).toEqual({ error: 'Not found', request_id: result.headers['X-Request-ID'] })
  })

  it('uses a trusted Vercel request id without echoing arbitrary input', async () => {
    const result: { headers: Record<string, string> } = { headers: {} }
    const res = {
      status() { return res }, json() {}, setHeader(key: string, value: string) { result.headers[key] = value }, send() {},
    }
    await handler({ url: '/api/not-a-route', query: {}, headers: { 'x-vercel-id': 'sfo1::abc_123' } }, res)
    expect(result.headers['X-Request-ID']).toBe('sfo1::abc_123')
  })

  it('dispatches the one-segment production cron route through the catch-all function', async () => {
    vi.stubEnv('CRON_SECRET', 'configured-secret')
    const result: { statusCode: number; body: unknown } = { statusCode: 0, body: null }
    const res = {
      status(code: number) { result.statusCode = code; return res },
      json(body: unknown) { result.body = body },
      setHeader() {},
      send() {},
    }

    await handler({ method: 'GET', url: '/api/purge-expired-shares', query: {}, headers: {} }, res)

    expect(result.statusCode).toBe(401)
    expect(result.body).toMatchObject({ error: 'Unauthorized' })
  })

  it.each([
    '/api/reconcile-billing',
    '/api/billing-ops',
    '/api/ai-ops',
  ])('dispatches the flat hosted operations route %s', async (url) => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('CRON_SECRET', 'configured-secret')
    vi.stubEnv('MOXSCORE_ENABLE_BILLING', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_BILLING_RECONCILIATION', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_PRO_AI', 'true')
    const result: { statusCode: number; body: unknown } = { statusCode: 0, body: null }
    const res = {
      status(code: number) { result.statusCode = code; return res },
      json(body: unknown) { result.body = body },
      setHeader() {},
      send() {},
    }

    await handler({ method: 'GET', url, query: {}, headers: {} }, res)

    expect(result.statusCode).toBe(401)
    expect(result.body).toMatchObject({ error: 'Unauthorized' })
  })
})
