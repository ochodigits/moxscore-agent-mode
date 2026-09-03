import { describe, expect, it } from 'vitest'
import handler from './_routes/og'

describe('/api/og', () => {
  it('returns a genuine 1200x630 PNG response for a generic share preview', async () => {
    const result: { statusCode: number; headers: Record<string, string>; body: Buffer | null } = { statusCode: 0, headers: {}, body: null }
    const res = {
      status(code: number) { result.statusCode = code; return res },
      setHeader(key: string, value: string) { result.headers[key] = value },
      send(body: string | Buffer) { result.body = Buffer.isBuffer(body) ? body : Buffer.from(body) },
    }
    await handler({ query: {} }, res)
    expect(result.statusCode).toBe(200)
    expect(result.headers['Content-Type']).toBe('image/png')
    expect(result.body?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })
})
