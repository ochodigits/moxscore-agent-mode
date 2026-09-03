import { accountAccess, accountError, isUuid } from '../_account.js'

const MAX_SNAPSHOT_BYTES = 250_000
const MAX_VERSIONS = 20

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

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null
}

function snapshot(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_SNAPSHOT_BYTES ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function operationError(error: { code?: string } | null): { status: number; error: string } {
  if (error?.code === 'P0001') return { status: 409, error: 'Deck version limit reached.' }
  if (error?.code === 'P0002') return { status: 404, error: 'Saved deck not found' }
  if (error?.code === '22023') return { status: 400, error: 'Invalid deck version' }
  return { status: 503, error: 'Saved decks are temporarily unavailable.' }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const access = await accountAccess(req.headers, 'persistence')
  if (access.kind !== 'ready') {
    const error = accountError(access)
    res.status(error.status).json({ error: error.error })
    return
  }

  if (req.method === 'GET') {
    const deckId = req.query?.deckId
    if (!isUuid(deckId)) {
      res.status(400).json({ error: 'Invalid saved deck id' })
      return
    }
    const owned = await access.db
      .from('saved_decks')
      .select('id')
      .eq('id', deckId)
      .eq('owner_id', access.user.id)
      .maybeSingle()
    if (owned.error) {
      res.status(503).json({ error: 'Saved decks are temporarily unavailable.' })
      return
    }
    if (owned.data === null) {
      res.status(404).json({ error: 'Saved deck not found' })
      return
    }
    const { data, error } = await access.db
      .from('deck_versions')
      .select('id, version_number, analysis_snapshot, analyzer_version, curated_data_version, created_at')
      .eq('deck_id', deckId)
      .order('version_number', { ascending: false })
    if (error) {
      res.status(503).json({ error: 'Saved decks are temporarily unavailable.' })
      return
    }
    res.status(200).json({ versions: data ?? [] })
    return
  }

  let body: Record<string, unknown>
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as Record<string, unknown>)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const deckId = body?.deckId
  const decklist = text(body?.decklist, 20_000)
  const analysisSnapshot = snapshot(body?.analysisSnapshot)
  const analyzerVersion = text(body?.analyzerVersion, 100)
  const curatedDataVersion = text(body?.curatedDataVersion, 100)
  if (!isUuid(deckId) || decklist === null || analysisSnapshot === null || analyzerVersion === null || curatedDataVersion === null) {
    res.status(400).json({ error: 'Invalid deck version' })
    return
  }

  const { data, error } = await access.db.rpc('moxscore_create_deck_version', {
    p_owner_id: access.user.id,
    p_deck_id: deckId,
    p_decklist: decklist,
    p_analysis_snapshot: analysisSnapshot,
    p_analyzer_version: analyzerVersion,
    p_curated_data_version: curatedDataVersion,
    p_limit: MAX_VERSIONS,
  })
  if (error || data === null) {
    const response = operationError(error)
    res.status(response.status).json({ error: response.error })
    return
  }
  res.status(201).json({ version: data })
}
