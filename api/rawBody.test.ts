import { describe, expect, it } from 'vitest'
import handler, { config } from './[...path]'

/** Minimal response double matching the router's VercelRes shape. */
function recorder() {
  const result: { statusCode: number; headers: Record<string, string>; body: unknown } = {
    statusCode: 200,
    headers: {},
    body: null,
  }
  const res = {
    status(code: number) {
      result.statusCode = code
      return res
    },
    json(body: unknown) {
      result.body = body
    },
    setHeader(key: string, value: string) {
      result.headers[key] = value
    },
    send() {},
  }
  return { res, result }
}

/** A request whose body arrives as a stream, the way Vercel delivers it. */
function streamingRequest(chunks: string[], extra: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/health',
    query: {},
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
    ...extra,
  }
}

describe('router raw body handling', () => {
  it('disables Vercel body parsing for the whole API surface', () => {
    // Stripe signature verification depends on this; a regression here breaks
    // webhooks silently, so it is asserted rather than assumed.
    expect(config).toEqual({ api: { bodyParser: false } })
  })

  it('drains a streamed body into a string on req.body and req.rawBody', async () => {
    const { res } = recorder()
    const req = streamingRequest(['{"a":', '1}']) as Record<string, unknown>
    await handler(req as never, res)
    expect(req.rawBody).toBe('{"a":1}')
    expect(req.body).toBe('{"a":1}')
  })

  it('preserves exact bytes across chunk boundaries', async () => {
    // Signature verification is byte-exact: key order, spacing, and unicode
    // escaping must survive reassembly untouched.
    const payload = '{"id":"evt_1","note":"  spaced  ","emoji":"🜁","z":1,"a":2}'
    const { res } = recorder()
    const req = streamingRequest([payload.slice(0, 9), payload.slice(9, 30), payload.slice(30)]) as Record<
      string,
      unknown
    >
    await handler(req as never, res)
    expect(req.rawBody).toBe(payload)
  })

  it('leaves an empty body undefined so GET routes are unaffected', async () => {
    const { res } = recorder()
    const req = streamingRequest([]) as Record<string, unknown>
    await handler(req as never, res)
    expect(req.body).toBeUndefined()
    expect(req.rawBody).toBeUndefined()
  })

  it('accepts a string body unchanged, matching the dev server', async () => {
    // vite.config.ts drains the stream itself and passes a string. Dev and
    // production must reach routes with identical body shapes.
    const { res } = recorder()
    const req = { method: 'POST', url: '/api/health', query: {}, headers: {}, body: '{"a":1}' } as Record<
      string,
      unknown
    >
    await handler(req as never, res)
    expect(req.body).toBe('{"a":1}')
    expect(req.rawBody).toBe('{"a":1}')
  })

  it('rejects an oversized body with 413 before dispatching to a route', async () => {
    const { res, result } = recorder()
    const oversized = 'x'.repeat(4 * 1024 * 1024 + 1)
    await handler(streamingRequest([oversized]) as never, res)
    expect(result.statusCode).toBe(413)
    expect(result.body).toMatchObject({ error: 'Request body is too large' })
  })

  it('still resolves unknown routes before reading any body', async () => {
    const { res, result } = recorder()
    await handler(streamingRequest(['{}'], { url: '/api/not-a-route' }) as never, res)
    expect(result.statusCode).toBe(404)
  })
})
