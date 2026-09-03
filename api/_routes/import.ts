// Vercel serverless function: import a decklist from a Moxfield or Archidekt URL.
//
// POST /api/import  { url: string }
//   -> 200 { decklist, name, commander, source }   decklist is plain text in the
//      format the app's parser understands ("// Commander\n1 Card\n\n1 Card ...")
//   -> 400 { error } for bad/unsupported URLs
//   -> 502 { error } when the upstream (unofficial) API fails — caller should fall
//      back to asking the user to paste their list.
//
// The Moxfield API is unofficial and undocumented; treat it as fragile.

import { enforcePublicRateLimit } from '../_rateLimit.js'

interface DeckResult {
  decklist: string
  name: string
  commander: string | null
  source: 'moxfield' | 'archidekt'
}

const IMPORT_FALLBACK =
  "We couldn't import that deck right now. The deck site may be blocking automated requests, so paste the decklist instead and Moxscore will still analyze it."

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(250 * attempt)
    try {
      const response = await fetchWithTimeout(url, init)
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        return response
      }
      lastResponse = response
    } catch {
      if (attempt === attempts - 1) throw new Error('Network request failed')
    }
  }

  return lastResponse ?? fetchWithTimeout(url, init)
}

function extractMoxfieldId(url: string): string | null {
  const m = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/)
  return m?.[1] ?? null
}

function extractArchidektId(url: string): string | null {
  const m = url.match(/archidekt\.com\/(?:decks|api\/decks)\/(\d+)/)
  return m?.[1] ?? null
}

// Build the plain-text decklist the analyzer expects. Commanders go under a
// "// Commander" header so localEngine flags them; everything else is "qty name".
function buildDecklist(name: string, commanders: string[], cards: { name: string; qty: number }[]): string {
  const lines: string[] = []
  if (name) lines.push(`// ${name}`)
  if (commanders.length) {
    lines.push('// Commander')
    for (const c of commanders) lines.push(`1 ${c}`)
    lines.push('')
  }
  for (const c of cards) lines.push(`${c.qty} ${c.name}`)
  return lines.join('\n')
}

async function importMoxfieldApi(id: string): Promise<DeckResult> {
  const res = await fetchWithRetry(`https://api2.moxfield.com/v3/decks/all/${id}`, {
    headers: {
      // Do not impersonate a browser or a user. This unsupported integration
      // is deliberately best-effort; a refusal takes the user to paste/export.
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Moxfield responded ${res.status}`)
  const data = (await res.json()) as Record<string, unknown>

  // v3 nests boards under data.boards; v2 exposed them directly on the root.
  type CardEntry = { quantity?: number; card?: { name?: string } }

  const collect = (board: unknown): { name: string; qty: number }[] => {
    if (!board || typeof board !== 'object') return []
    // v3: { cards: { uuid: CardEntry } }
    const raw = 'cards' in (board as object)
      ? Object.values((board as { cards: Record<string, CardEntry> }).cards)
      : Array.isArray(board)
        ? (board as CardEntry[])
        : Object.values(board as Record<string, CardEntry>)
    return (raw as CardEntry[])
      .map((e) => ({ name: e?.card?.name ?? '', qty: e?.quantity ?? 1 }))
      .filter((e) => e.name)
  }

  // Support both v3 (data.boards.commanders) and v2 (data.commanders) layouts.
  const boards = (data.boards ?? data) as Record<string, unknown>
  const commanders = collect(boards.commanders).map((c) => c.name)
  const cards = collect(boards.mainboard)

  return {
    decklist: buildDecklist(String(data.name ?? ''), commanders, cards),
    name: String(data.name ?? ''),
    commander: commanders[0] ?? null,
    source: 'moxfield',
  }
}

async function importMoxfield(id: string): Promise<DeckResult> {
  return importMoxfieldApi(id)
}

async function importArchidekt(id: string): Promise<DeckResult> {
  const res = await fetchWithRetry(`https://archidekt.com/api/decks/${id}/`, {
    headers: {
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Archidekt responded ${res.status}`)
  const data = (await res.json()) as {
    name?: string
    cards?: Array<{
      quantity?: number
      categories?: string[]
      card?: {
        oracleCard?: { name?: string }
        // Older API shape used card.name directly
        name?: string
      }
    }>
  }

  const commanders: string[] = []
  const cards: { name: string; qty: number }[] = []
  for (const entry of data.cards ?? []) {
    const name = entry?.card?.oracleCard?.name ?? entry?.card?.name
    if (!name) continue
    const qty = entry.quantity ?? 1
    if ((entry.categories ?? []).some((c) => /commander/i.test(c))) {
      commanders.push(name)
    } else {
      cards.push({ name, qty })
    }
  }

  return {
    decklist: buildDecklist(data.name ?? '', commanders, cards),
    name: data.name ?? '',
    commander: commanders[0] ?? null,
    source: 'archidekt',
  }
}

export default async function handler(
  req: { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> },
  res: VercelRes,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const rateLimit = enforcePublicRateLimit(req.headers, { scope: 'import-post', limit: 20, windowMs: 60_000 })
  if (rateLimit === 'unconfigured') {
    res.status(503).json({ error: 'URL import is temporarily unavailable. Paste or upload your decklist instead.' })
    return
  }
  if (rateLimit === 'limited') {
    res.status(429).json({ error: 'Too many import requests — try again in a minute.' })
    return
  }

  let url: string
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    url = String((body as { url?: string })?.url ?? '').trim()
  } catch {
    res.status(400).json({ error: 'Invalid request body' })
    return
  }

  if (!url) {
    res.status(400).json({ error: 'Missing deck URL' })
    return
  }

  try {
    const moxId = extractMoxfieldId(url)
    const archId = extractArchidektId(url)

    let result: DeckResult
    if (moxId) {
      result = await importMoxfield(moxId)
    } else if (archId) {
      result = await importArchidekt(archId)
    } else {
      res.status(400).json({ error: 'Unsupported URL — paste a Moxfield or Archidekt deck link.' })
      return
    }

    if (!result.decklist.trim()) {
      res.status(502).json({ error: 'Imported deck was empty. Try pasting the list instead.' })
      return
    }

    res.status(200).json(result)
  } catch {
    res.status(502).json({
      error: IMPORT_FALLBACK,
    })
  }
}

// Minimal response typing so this file needs no @vercel/node types to compile.
interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}
