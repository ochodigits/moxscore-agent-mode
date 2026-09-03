/**
 * Commander Spellbook client — finds two-card infinite combos contained in a
 * decklist. Injectable (SpellbookClient interface) so the bracket engine can
 * be unit-tested without the network, and cached per deck hash because the
 * lookup is by far the slowest part of a bracket analysis.
 */

export interface SpellbookDeck {
  commanders: string[]
  main: string[]
}

/** Each combo is the list of card names it uses (deck cards only). */
export interface SpellbookClient {
  findCombos(deck: SpellbookDeck): Promise<string[][]>
}

const API_URL = '/api/combos'
const CACHE_PREFIX = 'moxscore:combos:'
const memoryCache = new Map<string, string[][]>()

/** Order-independent djb2 hash of the deck's card names. */
export function deckHash(deck: SpellbookDeck): string {
  const names = [...deck.commanders, ...deck.main].map((n) => n.toLowerCase()).sort()
  let h = 5381
  for (const ch of names.join('\n')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  return h.toString(36)
}

function readPersistentCache(key: string): string[][] | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    return raw === null ? null : (JSON.parse(raw) as string[][])
  } catch {
    return null
  }
}

function writePersistentCache(key: string, combos: string[][]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(combos))
  } catch {
    // Quota exceeded — combos are recomputable, safe to drop.
  }
}

interface FindMyCombosResponse {
  combos?: unknown
}

export class HttpSpellbookClient implements SpellbookClient {
  async findCombos(deck: SpellbookDeck): Promise<string[][]> {
    const key = deckHash(deck)
    const cached = memoryCache.get(key) ?? readPersistentCache(key)
    if (cached !== null && cached !== undefined) {
      memoryCache.set(key, cached)
      return cached
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commanders: deck.commanders,
        main: deck.main,
      }),
    })
    if (!res.ok) throw new Error(`Combo API ${res.status}`)

    const json = (await res.json()) as FindMyCombosResponse
    if (!Array.isArray(json.combos)) throw new Error('Invalid combo response')
    const combos = json.combos.filter(
      (combo): combo is string[] => Array.isArray(combo) && combo.length === 2 && combo.every((name) => typeof name === 'string'),
    )

    memoryCache.set(key, combos)
    writePersistentCache(key, combos)
    return combos
  }
}
