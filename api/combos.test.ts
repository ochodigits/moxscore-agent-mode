import { afterEach, describe, expect, it, vi } from 'vitest'
import handler, { clearComboCacheForTests } from './_routes/combos'

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

let ipCounter = 0
const nextIp = () => `172.16.0.${++ipCounter}`
const request = (body: unknown, ip = nextIp()) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'x-forwarded-for': ip },
})

const response = (included: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ results: { included } }),
}) as Response

afterEach(() => {
  vi.restoreAllMocks()
  clearComboCacheForTests()
})

describe('combos api', () => {
  it('normalizes and de-duplicates only two-card included combos', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([
      { uses: [{ card: { name: 'Demonic Consultation' } }, { card: { name: "Thassa's Oracle" } }] },
      { uses: [{ card: { name: "Thassa's Oracle" } }, { card: { name: 'Demonic Consultation' } }] },
      { uses: [{ card: { name: 'A' } }, { card: { name: 'B' } }, { card: { name: 'C' } }] },
    ]))
    const { res, result } = createRes()

    await handler(request({ commanders: ['Wilhelt, the Rotcleaver'], main: ["Thassa's Oracle", 'Demonic Consultation'] }), res)

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ combos: [['Demonic Consultation', "Thassa's Oracle"]] })
  })

  it('returns an empty normalized list when no combo is included', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([]))
    const { res, result } = createRes()
    await handler(request({ commanders: ['No Combo Commander'], main: ['Forest'] }), res)
    expect(result).toEqual({ statusCode: 200, body: { combos: [] } })
  })

  it('rejects invalid or oversized bodies before the upstream call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const { res, result } = createRes()
    await handler(request({ commanders: [], main: Array.from({ length: 101 }, (_, index) => `Card ${index}`) }), res)
    expect(result.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 504 for an upstream timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const { res, result } = createRes()
    await handler(request({ commanders: ['Timeout Commander'], main: ['Timeout Card'] }), res)
    expect(result.statusCode).toBe(504)
  })

  it('returns 502 for an upstream error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response)
    const { res, result } = createRes()
    await handler(request({ commanders: ['Error Commander'], main: ['Error Card'] }), res)
    expect(result.statusCode).toBe(502)
  })

  it('rate limits repeated requests from one client', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([]))
    const ip = nextIp()
    let lastStatus = 200
    for (let index = 0; index < 31; index += 1) {
      clearComboCacheForTests()
      const { res, result } = createRes()
      await handler(request({ commanders: ['Rate Commander'], main: [`Rate Card ${index}`] }, ip), res)
      lastStatus = result.statusCode
    }
    expect(lastStatus).toBe(429)
  })
})
