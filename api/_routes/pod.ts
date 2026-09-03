// Vercel serverless function: persist & load shared pod checks.
//
// POST /api/pod  { decks: [{ decklist, label? } x2-4] } -> 201 { podId }
// GET  /api/pod?id=abc123                               -> 200 { decks }
//
// Backed by the Supabase `shared_pods` table (see supabase/migrations).
// Same access model as api/deck.ts: RLS with no public policies, all access
// via the service-role key, size-capped and rate-limited writes.

import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, clientIp } from '../_rateLimit.js'
import { deferredPodEnabled } from '../_featureFlags.js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const POD_ID_RE = /^[a-z0-9]{8}$/
const MAX_DECKLIST_BYTES = 20_000
const MAX_LABEL = 80
const ID_INSERT_ATTEMPTS = 3

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function makePodId(len = 8): string {
  const bytes = new Uint8Array(len)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

interface PodDeck {
  decklist: string
  label: string | null
}

interface VercelReq {
  method?: string
  body?: unknown
  query?: Record<string, string | string[] | undefined>
  headers?: Record<string, string | string[] | undefined>
}
interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

function parseDecks(raw: unknown): PodDeck[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return null
  const decks: PodDeck[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const decklist = typeof (item as { decklist?: unknown }).decklist === 'string'
      ? ((item as { decklist: string }).decklist).trim()
      : ''
    if (!decklist || Buffer.byteLength(decklist, 'utf8') > MAX_DECKLIST_BYTES) return null
    const rawLabel = (item as { label?: unknown }).label
    decks.push({
      decklist,
      label: typeof rawLabel === 'string' ? rawLabel.slice(0, MAX_LABEL) : null,
    })
  }
  return decks
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (!deferredPodEnabled()) {
    res.status(404).json({ error: 'Not available' })
    return
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Storage is not configured.' })
    return
  }

  if (req.method === 'GET') {
    const raw = req.query?.id
    const podId = Array.isArray(raw) ? raw[0] : raw
    if (!podId || !POD_ID_RE.test(podId)) {
      res.status(400).json({ error: 'Invalid pod id' })
      return
    }
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data, error } = await db.from('shared_pods').select('decks').eq('pod_id', podId).maybeSingle()
    if (error) {
      res.status(500).json({ error: 'Lookup failed' })
      return
    }
    if (!data) {
      res.status(404).json({ error: 'Pod not found' })
      return
    }
    res.status(200).json(data)
    return
  }

  if (req.method === 'POST') {
    if (!checkRateLimit(clientIp(req.headers), { scope: 'pod-post', limit: 10, windowMs: 60_000 })) {
      res.status(429).json({ error: 'Too many saves — try again in a minute.' })
      return
    }

    let body: { decks?: unknown }
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
    } catch {
      res.status(400).json({ error: 'Invalid body' })
      return
    }
    const decks = parseDecks(body?.decks)
    if (decks === null) {
      res.status(400).json({ error: 'Pod needs 2–4 decks, each a non-empty decklist under 20KB.' })
      return
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    for (let attempt = 0; attempt < ID_INSERT_ATTEMPTS; attempt += 1) {
      const podId = makePodId()
      const { error } = await db.from('shared_pods').insert({ pod_id: podId, decks })
      if (!error) {
        res.status(201).json({ podId })
        return
      }
      if (error.code !== '23505') break
    }
    res.status(500).json({ error: 'Could not save pod' })
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}
