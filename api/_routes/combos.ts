// Same-origin Commander Spellbook boundary for the v1 bracket beta.

import { createHash } from 'node:crypto'
import { enforcePublicRateLimit } from '../_rateLimit.js'

const SPELLBOOK_URL = 'https://backend.commanderspellbook.com/find-my-combos'
const UPSTREAM_TIMEOUT_MS = 9_000
const MAX_COMMANDERS = 2
const MAX_MAIN_NAMES = 100
const MAX_NAME_LENGTH = 160
const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 500

interface ComboRequest {
  commanders?: unknown
  main?: unknown
}

interface ValidDeck {
  commanders: string[]
  main: string[]
}

interface VercelReq {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

interface SpellbookResponse {
  results?: {
    included?: Array<{
      uses?: Array<{ card?: { name?: unknown } }>
    }>
  }
}

interface CacheEntry {
  combos: string[][]
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function normalizeNames(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) return null
  const names: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string') return null
    const name = value.trim()
    if (!name || name.length > MAX_NAME_LENGTH || containsControlCharacter(name)) return null
    const key = name.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names.length > 0 && names.length <= max ? names : null
}

function parseDeck(raw: ComboRequest): ValidDeck | null {
  const commanders = normalizeNames(raw.commanders, MAX_COMMANDERS)
  const main = normalizeNames(raw.main, MAX_MAIN_NAMES)
  if (commanders === null || main === null) return null
  const commanderNames = new Set(commanders.map((name) => name.toLocaleLowerCase('en-US')))
  const withoutCommanders = main.filter((name) => !commanderNames.has(name.toLocaleLowerCase('en-US')))
  return { commanders, main: withoutCommanders }
}

function deckHash(deck: ValidDeck): string {
  const names = [...deck.commanders, ...deck.main]
    .map((name) => name.toLocaleLowerCase('en-US'))
    .sort()
  return createHash('sha256').update(names.join('\n')).digest('base64url')
}

function readCache(key: string): string[][] | null {
  const hit = cache.get(key)
  if (hit === undefined) return null
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.combos
}

function writeCache(key: string, combos: string[][]): void {
  cache.set(key, { combos, expiresAt: Date.now() + CACHE_TTL_MS })
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function normalizeCombos(payload: SpellbookResponse): string[][] {
  const combos: string[][] = []
  const seen = new Set<string>()
  for (const item of payload.results?.included ?? []) {
    const names = (item.uses ?? [])
      .map((use) => use.card?.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .map((name) => name.trim())
    if (names.length !== 2) continue
    const key = names.map((name) => name.toLocaleLowerCase('en-US')).sort().join('\n')
    if (seen.has(key)) continue
    seen.add(key)
    combos.push(names)
  }
  return combos
}

function logUpstreamError(status: number | 'network' | 'timeout', message: string): void {
  console.error(JSON.stringify({
    event: 'spellbook_error',
    endpoint: '/api/combos',
    status,
    message: message.replace(/[\r\n]+/g, ' ').slice(0, 300),
  }))
}

async function fetchSpellbook(deck: ValidDeck): Promise<string[][]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const response = await fetch(SPELLBOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commanders: deck.commanders.map((card) => ({ card, quantity: 1 })),
        main: deck.main.map((card) => ({ card, quantity: 1 })),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      logUpstreamError(response.status, `Commander Spellbook returned ${response.status}`)
      throw new Error('upstream')
    }
    return normalizeCombos((await response.json()) as SpellbookResponse)
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      logUpstreamError('timeout', 'Commander Spellbook timed out')
      throw new Error('timeout', { cause: error })
    }
    if (!(error instanceof Error && error.message === 'upstream')) {
      logUpstreamError('network', error instanceof Error ? error.message : 'Unknown network error')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const rateLimit = enforcePublicRateLimit(req.headers, { scope: 'combos-post', limit: 30, windowMs: 60_000 })
  if (rateLimit === 'unconfigured') {
    res.status(503).json({ error: 'Combo lookup is temporarily unavailable.' })
    return
  }
  if (rateLimit === 'limited') {
    res.status(429).json({ error: 'Too many combo checks — try again in a minute.' })
    return
  }

  let body: ComboRequest
  try {
    body = typeof req.body === 'string' ? (JSON.parse(req.body) as ComboRequest) : (req.body as ComboRequest)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }

  const deck = parseDeck(body ?? {})
  if (deck === null) {
    res.status(400).json({ error: 'Provide 1–2 commanders and 1–100 unique main-deck card names.' })
    return
  }

  const key = deckHash(deck)
  const cached = readCache(key)
  if (cached !== null) {
    res.status(200).json({ combos: cached })
    return
  }

  try {
    const combos = await fetchSpellbook(deck)
    writeCache(key, combos)
    res.status(200).json({ combos })
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout'
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'Combo lookup timed out.' : 'Combo lookup is unavailable.',
    })
  }
}

export function clearComboCacheForTests(): void {
  cache.clear()
}
