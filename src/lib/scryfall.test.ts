import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchCards } from './scryfall.ts'
import { normalizeDeck } from './normalizer.ts'
import type { ScryfallCard } from './scryfall.ts'

const ELADAMRIS_CALL: ScryfallCard = {
  id: 'eladamri-id',
  name: "Eladamri's Call",
  cmc: 2,
  mana_cost: '{G}{W}',
  type_line: 'Instant',
  oracle_text: 'Search your library for a creature card, reveal that card, put it into your hand, then shuffle.',
  colors: ['G', 'W'],
  color_identity: ['G', 'W'],
  keywords: [],
  prices: { usd: null, eur: null },
  set_name: 'Secret Lair Drop',
}

const SOL_RING: ScryfallCard = {
  id: 'sol-ring-id',
  name: 'Sol Ring',
  cmc: 1,
  mana_cost: '{1}',
  type_line: 'Artifact',
  oracle_text: '{T}: Add {C}{C}.',
  colors: [],
  color_identity: [],
  keywords: [],
  prices: { usd: null, eur: null },
  set_name: 'Commander',
}

function mockFetchSequence() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    // Batch collection: exact name lookup misses the flavor name.
    if (url.includes('/cards/collection')) {
      return {
        ok: true,
        json: async () => ({ data: [], not_found: [{ name: 'Lifelong Friendship' }] }),
      } as Response
    }
    // Fuzzy retry: Scryfall's fuzzy matcher does not know flavor names.
    if (url.includes('/cards/named')) {
      return { ok: false, status: 404, json: async () => ({ object: 'error' }) } as Response
    }
    // Alternate-name search: flavorname:"Lifelong Friendship" finds the card.
    if (url.includes('/cards/search') && decodeURIComponent(url).includes('flavorname:"Lifelong Friendship"')) {
      return { ok: true, json: async () => ({ data: [ELADAMRIS_CALL] }) } as Response
    }
    return { ok: false, status: 404, json: async () => ({ object: 'error' }) } as Response
  })
}

// Map-backed localStorage stub — the module caches cards through it, and the
// vitest jsdom environment does not always expose a working localStorage.
function stubLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  })
}

describe('fetchCards — alternate (flavor) name retry', () => {
  beforeEach(() => stubLocalStorage())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("resolves a Secret Lair flavor name to the canonical card (Lifelong Friendship → Eladamri's Call)", async () => {
    mockFetchSequence()
    const { cards, aliases } = await fetchCards([{ name: 'Lifelong Friendship', qty: 1 }])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.name).toBe("Eladamri's Call")
    expect(aliases['lifelong friendship']).toBe("Eladamri's Call")
  })

  it('the alias lets the normalizer match the entry — no unknown card', async () => {
    mockFetchSequence()
    const entries = [{ name: 'Lifelong Friendship', qty: 1 }]
    const { cards, aliases } = await fetchCards(entries)
    const { cards: normalized, unresolved } = normalizeDeck(entries, cards, aliases)
    expect(unresolved).toEqual([])
    expect(normalized).toHaveLength(1)
    expect(normalized[0]!.name).toBe("Eladamri's Call")
    expect(normalized[0]!.isDraw || normalized[0]!.oracle_text.length > 0).toBe(true)
  })

  it('caches under the requested name so later sessions resolve without the search retry', async () => {
    const spy = mockFetchSequence()
    await fetchCards([{ name: 'Lifelong Friendship', qty: 1 }])
    const callsFirstRun = spy.mock.calls.length
    // Second run: cache hit under the flavor name; alias still reported.
    const { cards, aliases } = await fetchCards([{ name: 'Lifelong Friendship', qty: 1 }])
    expect(spy.mock.calls.length).toBe(callsFirstRun) // no new network calls
    expect(cards[0]!.name).toBe("Eladamri's Call")
    expect(aliases['lifelong friendship']).toBe("Eladamri's Call")
  })
})

describe('fetchCards — bounded, resilient Scryfall access', () => {
  beforeEach(() => stubLocalStorage())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('honors a zero-second 429 Retry-After response and retries the collection request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: () => '0' },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [SOL_RING], not_found: [] }),
      } as Response)

    const { cards } = await fetchCards([{ name: 'Sol Ring', qty: 1 }])

    expect(cards).toEqual([SOL_RING])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('limits alternate-name resolution to three concurrent requests', async () => {
    let active = 0
    let maximum = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/cards/collection')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [], not_found: ['One', 'Two', 'Three', 'Four', 'Five'] }),
        } as Response
      }

      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { ok: false, status: 404, json: async () => ({ object: 'error' }) } as Response
    })

    await fetchCards(['One', 'Two', 'Three', 'Four', 'Five'].map((name) => ({ name, qty: 1 })))

    expect(maximum).toBeLessThanOrEqual(3)
  })

  it('does not reuse the prior cache namespace after a cache-version change', async () => {
    const legacy = new Map<string, string>([['moxscore:card:sol ring', JSON.stringify(SOL_RING)]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => legacy.get(key) ?? null,
      setItem: (key: string, value: string) => void legacy.set(key, value),
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [SOL_RING], not_found: [] }),
    } as Response)

    const { cards } = await fetchCards([{ name: 'Sol Ring', qty: 1 }])

    expect(cards).toEqual([SOL_RING])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
