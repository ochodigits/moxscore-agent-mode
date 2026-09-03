import { afterEach, describe, expect, it, vi } from 'vitest'
import handler from './_routes/import'

interface MockReq {
  method: string
  body: string
}

interface MockRes {
  status(code: number): MockRes
  json(body: unknown): void
}

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res: MockRes = {
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

describe('import api', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('imports a Moxfield deck from the JSON API', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'Public Deck',
          boards: {
            commanders: {
              a: { quantity: 1, card: { name: 'Atraxa, Praetors Voice' } },
            },
            mainboard: {
              b: { quantity: 1, card: { name: 'Sol Ring' } },
              c: { quantity: 1, card: { name: 'Command Tower' } },
            },
          },
        }),
      } as Response)

    const { res, result } = createRes()
    const req: MockReq = {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.moxfield.com/decks/abc123' }),
    }

    await handler(req, res)

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({
      decklist: '// Public Deck\n// Commander\n1 Atraxa, Praetors Voice\n\n1 Sol Ring\n1 Command Tower',
      name: 'Public Deck',
      commander: 'Atraxa, Praetors Voice',
      source: 'moxfield',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api2.moxfield.com/v3/decks/all/abc123',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    )
  })

  it('returns a paste fallback when the Moxfield JSON API is blocked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
    } as Response)

    const { res, result } = createRes()
    const req: MockReq = {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.moxfield.com/decks/abc123' }),
    }

    await handler(req, res)

    expect(result.statusCode).toBe(502)
    expect(result.body).toEqual({
      error: "We couldn't import that deck right now. The deck site may be blocking automated requests, so paste the decklist instead and Moxscore will still analyze it.",
    })
  })
})
