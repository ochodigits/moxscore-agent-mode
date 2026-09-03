import type { DeckEntry } from './parser.ts'

/**
 * One face of a double-faced / modal / split card. Scryfall omits root-level
 * oracle_text, mana_cost, and image_uris for these layouts and puts the data
 * here instead — ignoring card_faces makes every MDFC invisible to analysis.
 */
export interface ScryfallCardFace {
  name: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  colors?: string[]
  power?: string
  image_uris?: { normal: string }
}

export interface ScryfallCard {
  id: string
  /** Printing-independent card identity — used to match bracket data lists. */
  oracle_id?: string
  name: string
  cmc: number
  mana_cost?: string
  type_line: string
  colors?: string[]
  color_identity?: string[]
  legalities?: Record<string, string>
  oracle_text?: string
  power?: string
  keywords?: string[]
  layout?: string
  card_faces?: ScryfallCardFace[]
  prices: {
    usd: string | null
    eur: string | null
  }
  set_name: string
  image_uris?: { normal: string }
}

interface ScryfallCollectionResponse {
  data: ScryfallCard[]
  not_found: Array<{ name: string }>
}

interface ScryfallErrorResponse {
  object: 'error'
}

// Bump this when normalized card fields or analysis-relevant Scryfall handling
// changes. Old cache entries stay harmlessly unused instead of mixing shapes.
const CACHE_VERSION = 'v2'
const CACHE_PREFIX = `moxscore:${CACHE_VERSION}:card:`
const BATCH_SIZE = 75
const BATCH_DELAY_MS = 100
const BATCH_CONCURRENCY = 2
const ALTERNATE_CONCURRENCY = 3
const REQUEST_TIMEOUT_MS = 8_000
const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers?.get('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 10_000)
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 10_000)
  }
  // A small capped exponential backoff respects Scryfall's 429 response while
  // keeping a degraded analyzer responsive enough to fall back locally.
  return Math.min(500 * 2 ** attempt, 4_000)
}

async function fetchScryfall(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(input, { ...init, signal: controller.signal })
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === MAX_RETRIES - 1) return response
      await sleep(retryDelay(response, attempt))
    } catch (error) {
      lastError = error
      if (attempt === MAX_RETRIES - 1) break
      await sleep(Math.min(500 * 2 ** attempt, 4_000))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Scryfall request failed')
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0

  async function runWorker(): Promise<void> {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await worker(values[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()))
  return results
}

function getCached(name: string): ScryfallCard | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + name.toLowerCase())
    if (raw === null) return null
    return JSON.parse(raw) as ScryfallCard
  } catch {
    // Private browsing and quota-restricted contexts must not break analysis.
    return null
  }
}

function setCache(card: ScryfallCard): void {
  try {
    localStorage.setItem(CACHE_PREFIX + card.name.toLowerCase(), JSON.stringify(card))
  } catch {
    // Caching is an optimization, never an analyzer dependency.
  }
}

/** Cache a card under an alternate requested name (flavor name, typo). */
function setCacheAs(requestedName: string, card: ScryfallCard): void {
  try {
    localStorage.setItem(CACHE_PREFIX + requestedName.toLowerCase(), JSON.stringify(card))
  } catch {
    // Caching is an optimization, never an analyzer dependency.
  }
}

async function fetchBatch(names: string[]): Promise<{ found: ScryfallCard[]; notFound: string[] }> {
  const response = await fetchScryfall('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers: names.map((name) => ({ name })) }),
  })
  if (!response.ok) {
    throw new Error(`Scryfall API error: ${response.status} ${response.statusText}`)
  }
  const json = (await response.json()) as ScryfallCollectionResponse
  return {
    found: json.data,
    notFound: (json.not_found ?? []).map((e) => e.name),
  }
}

async function fetchFuzzy(name: string): Promise<ScryfallCard | null> {
  try {
    const res = await fetchScryfall(
      `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`,
      {},
    )
    if (!res.ok) return null
    const data = (await res.json()) as ScryfallCard | ScryfallErrorResponse
    return 'object' in data && data.object === 'error' ? null : (data as ScryfallCard)
  } catch {
    return null
  }
}

/**
 * Last-resort retry: alternate printed names. Secret Lair / crossover cards
 * carry a "flavor name" (e.g. "Lifelong Friendship" is a printing of
 * Eladamri's Call) — deck builders export that name, exact and fuzzy lookups
 * both miss it, but Scryfall's search syntax can find it via `flavorname:`.
 */
async function fetchByFlavorName(name: string): Promise<ScryfallCard | null> {
  try {
    const q = `flavorname:"${name.replace(/"/g, '')}"`
    const res = await fetchScryfall(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}`, {})
    if (!res.ok) return null
    const data = (await res.json()) as { data?: ScryfallCard[] } | ScryfallErrorResponse
    if ('object' in data && data.object === 'error') return null
    return (data as { data?: ScryfallCard[] }).data?.[0] ?? null
  } catch {
    return null
  }
}

/** Retry a missed name: fuzzy match first, then alternate/flavor name. */
async function fetchAlternate(name: string): Promise<ScryfallCard | null> {
  return (await fetchFuzzy(name)) ?? (await fetchByFlavorName(name))
}

export interface FetchCardsResult {
  cards: ScryfallCard[]
  /**
   * requested-name (lowercased) → canonical Scryfall name, for every entry
   * that resolved to a card whose real name differs from what the decklist
   * said (flavor names, typo fuzzy matches). The normalizer needs this to
   * match those entries back to their cards.
   */
  aliases: Record<string, string>
}

export async function fetchCards(entries: DeckEntry[]): Promise<FetchCardsResult> {
  const uniqueNames = [...new Set(entries.map((e) => e.name))]

  const cards: ScryfallCard[] = []
  const aliases: Record<string, string> = {}
  const toFetch: string[] = []

  const record = (requested: string, card: ScryfallCard) => {
    cards.push(card)
    if (card.name.toLowerCase() !== requested.toLowerCase()) {
      aliases[requested.toLowerCase()] = card.name
    }
  }

  for (const name of uniqueNames) {
    const hit = getCached(name)
    if (hit !== null) {
      record(name, hit)
    } else {
      toFetch.push(name)
    }
  }

  const notFound: string[] = []

  // First pass: collection endpoint requests are deliberately small and
  // bounded. This prevents a large pasted list from producing an unbounded
  // burst while still resolving a 100-card list promptly.
  const batches = Array.from({ length: Math.ceil(toFetch.length / BATCH_SIZE) }, (_, index) =>
    toFetch.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
  )
  const batchResults = await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch, index) => {
    if (index > 0) await sleep(BATCH_DELAY_MS)
    return fetchBatch(batch)
  })
  for (const { found, notFound: missed } of batchResults) {
    for (const card of found) {
      setCache(card)
      record(card.name, card)
    }
    notFound.push(...missed)
  }

  // Second pass: for names Scryfall couldn't match exactly, try a fuzzy
  // match (typos, Aether vs Æther), then an alternate-name search (Secret
  // Lair flavor names). Cache the result under the REQUESTED name too, so
  // the alias survives into future cache-hit sessions.
  if (notFound.length > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    const retries = await mapWithConcurrency(notFound, ALTERNATE_CONCURRENCY, async (name) => {
      try {
        return await fetchAlternate(name)
      } catch {
        return null
      }
    })
    retries.forEach((r, i) => {
      const requested = notFound[i]
      if (r !== null && requested !== undefined) {
        setCache(r)
        setCacheAs(requested, r)
        record(requested, r)
      }
    })
  }

  return { cards, aliases }
}
