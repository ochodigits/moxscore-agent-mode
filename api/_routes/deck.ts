// Vercel serverless function: persist & load shared deck analyses.
//
// POST /api/deck   { decklist, name?, commander?, score?, format? } -> 201 { slug }
// GET  /api/deck?slug=abc123                       -> 200 { decklist, name, commander, score, format }
//
// Backed by the Supabase `shared_decks` table (see supabase/migrations).
// The table has NO public read policy (share-link obscurity: anyone holding
// the anon key must not be able to dump it via PostgREST), so both reads and
// writes go through the service-role key — explicitly, with no silent
// fallback to a weaker key. The write path is size-capped and rate-limited —
// see api/_rateLimit.ts and the WAF note there.

import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'node:crypto'
import { enforcePublicRateLimit } from '../_rateLimit.js'
import { logSupabaseError } from '../_supabaseErrors.js'
import { sharingWritesEnabled } from '../_sharingConfig.js'

const SLUG_RE = /^[a-z0-9]{8}$/
const MAX_DECKLIST_BYTES = 20_000
const MAX_TEXT_FIELD = 200
const SLUG_INSERT_ATTEMPTS = 3
const DEFAULT_RETENTION_DAYS = 90

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function makeSlug(len = 8): string {
  const bytes = new Uint8Array(len)
  globalThis.crypto.getRandomValues(bytes) // Node 18+ / Vercel runtime has global crypto
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

function retentionDays(raw = process.env.MOXSCORE_SHARED_DECK_RETENTION_DAYS ?? process.env.VITE_SHARED_DECK_RETENTION_DAYS): number {
  const value = Number(raw ?? DEFAULT_RETENTION_DAYS)
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : DEFAULT_RETENTION_DAYS
}

function deletionToken(): string {
  return randomBytes(32).toString('hex')
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
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

function clampScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

function storageConfig(): { url: string; serviceRoleKey: string } {
  return {
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const { url, serviceRoleKey } = storageConfig()

  if (req.method === 'GET') {
    // Fail fast if misconfigured — never silently fall back to a different key.
    if (!url || !serviceRoleKey) {
      res.status(500).json({ error: 'Storage is not configured.' })
      return
    }

    const raw = req.query?.slug
    const slug = Array.isArray(raw) ? raw[0] : raw
    if (!slug || !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid slug' })
      return
    }
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
    const { data, error } = await db
      .from('shared_decks')
      .select('decklist, name, commander, score, format')
      .eq('slug', slug)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (error) {
      logSupabaseError('/api/deck', 'select', error)
      res.status(500).json({ error: 'Lookup failed' })
      return
    }
    if (!data) {
      res.status(404).json({ error: 'Deck not found' })
      return
    }
    res.status(200).json(data)
    return
  }

  if (req.method === 'DELETE') {
    if (!url || !serviceRoleKey) {
      res.status(500).json({ error: 'Storage is not configured.' })
      return
    }
    const raw = req.query?.slug
    const slug = Array.isArray(raw) ? raw[0] : raw
    let body: { deletionToken?: unknown }
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
    } catch {
      res.status(400).json({ error: 'Invalid body' })
      return
    }
    const suppliedToken = typeof body?.deletionToken === 'string' ? body.deletionToken : ''
    if (!slug || !SLUG_RE.test(slug) || !/^[a-f0-9]{64}$/i.test(suppliedToken)) {
      res.status(400).json({ error: 'Invalid deletion request' })
      return
    }
    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
    const { error } = await db
      .from('shared_decks')
      .delete()
      .eq('slug', slug)
      .eq('deletion_token_hash', tokenHash(suppliedToken))
    if (error) {
      logSupabaseError('/api/deck', 'delete', error)
      res.status(500).json({ error: 'Could not delete deck' })
      return
    }
    // Intentionally indistinguishable for a missing, expired, or mismatched
    // capability: never turn this endpoint into a share-link oracle.
    res.status(204).json({})
    return
  }

  if (req.method === 'POST') {
    if (!sharingWritesEnabled()) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (!url || !serviceRoleKey) {
      res.status(500).json({ error: 'Storage is not configured.' })
      return
    }

    const rateLimit = enforcePublicRateLimit(req.headers, { scope: 'deck-post', limit: 10, windowMs: 60_000 })
    if (rateLimit === 'unconfigured') {
      res.status(503).json({ error: 'Sharing is temporarily unavailable. Please try again later.' })
      return
    }
    if (rateLimit === 'limited') {
      res.status(429).json({ error: 'Too many saves — try again in a minute.' })
      return
    }

    let body: { decklist?: string; name?: string; commander?: string | null; score?: number; format?: string }
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
    } catch {
      res.status(400).json({ error: 'Invalid body' })
      return
    }
    const decklist = (body?.decklist ?? '').trim()
    if (!decklist) {
      res.status(400).json({ error: 'Missing decklist' })
      return
    }
    if (Buffer.byteLength(decklist, 'utf8') > MAX_DECKLIST_BYTES) {
      res.status(413).json({ error: 'Decklist is too large.' })
      return
    }
    const name = typeof body.name === 'string' ? body.name.slice(0, MAX_TEXT_FIELD) : null
    const commander = typeof body.commander === 'string' ? body.commander.slice(0, MAX_TEXT_FIELD) : null
    const format = 'commander'

    const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
    const expiresAt = new Date(Date.now() + retentionDays() * 24 * 60 * 60 * 1000).toISOString()
    const token = deletionToken()

    // Retry on the (astronomically rare) slug collision instead of 500ing.
    let lastInsertError: unknown
    for (let attempt = 0; attempt < SLUG_INSERT_ATTEMPTS; attempt += 1) {
      const slug = makeSlug()
      const { error } = await db.from('shared_decks').insert({
        slug,
        decklist,
        name,
        commander,
        format,
        score: clampScore(body.score),
        expires_at: expiresAt,
        deletion_token_hash: tokenHash(token),
      })
      if (!error) {
        res.status(201).json({ slug, deletionToken: token, expiresAt })
        return
      }
      lastInsertError = error
      if (error.code !== '23505') break // only retry unique violations
    }
    logSupabaseError('/api/deck', 'insert', lastInsertError)
    res.status(500).json({ error: 'Could not save deck' })
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}
