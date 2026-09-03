import { createClient } from '@supabase/supabase-js'
import { enforcePublicRateLimit } from '../_rateLimit.js'

const TIMEOUT_MS = 3_000

type Health = 'ok' | 'degraded' | 'unconfigured'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

async function reachable(url: string): Promise<Health> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    // A 4xx confirms the upstream is reachable without treating an endpoint's
    // request-shape requirement as an outage. Only transport/5xx is degraded.
    return response.status < 500 ? 'ok' : 'degraded'
  } catch {
    return 'degraded'
  } finally {
    clearTimeout(timeout)
  }
}

async function storageHealth(): Promise<Health> {
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (!url || !key) return 'unconfigured'
  try {
    const db = createClient(url, key, { auth: { persistSession: false } })
    const { error } = await db.from('shared_decks').select('slug').limit(1)
    return error ? 'degraded' : 'ok'
  } catch {
    return 'degraded'
  }
}

/** Redacted readiness probe for uptime monitoring; it never processes user data. */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const rateLimit = enforcePublicRateLimit(req.headers, { scope: 'health-get', limit: 60, windowMs: 60_000 })
  if (rateLimit === 'unconfigured') {
    res.status(503).json({ error: 'Health checks are temporarily unavailable.' })
    return
  }
  if (rateLimit === 'limited') {
    res.status(429).json({ error: 'Too many health checks' })
    return
  }

  const [scryfall, comboProxy, sharingStorage] = await Promise.all([
    reachable('https://api.scryfall.com/cards/named?exact=Sol%20Ring'),
    reachable('https://backend.commanderspellbook.com/find-my-combos'),
    storageHealth(),
  ])
  const overall: Health = scryfall === 'degraded' || comboProxy === 'degraded' || sharingStorage === 'degraded'
    ? 'degraded'
    : 'ok'
  res.status(overall === 'ok' ? 200 : 503).json({
    status: overall,
    checks: { app: 'ok', scryfall, combo_proxy: comboProxy, sharing_storage: sharingStorage },
  })
}
