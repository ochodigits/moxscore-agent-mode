import { accountAccess, accountError } from '../_account.js'

const MAX_CARDS = 10_000
const MAX_NAME_LENGTH = 200

type SourceType = 'manabox-csv' | 'generic-csv' | 'text'

interface CollectionCardInput {
  name?: unknown
  quantity?: unknown
  unresolved?: unknown
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

function sourceType(value: unknown): SourceType | null {
  return value === 'manabox-csv' || value === 'generic-csv' || value === 'text' ? value : null
}

function cards(value: unknown): Array<{ name: string; quantity: number; unresolved: boolean }> | null {
  if (!Array.isArray(value) || value.length > MAX_CARDS) return null
  const result: Array<{ name: string; quantity: number; unresolved: boolean }> = []
  for (const raw of value as CollectionCardInput[]) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
    const quantity = raw?.quantity
    if (!name || name.length > MAX_NAME_LENGTH || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null
    result.push({ name, quantity, unresolved: raw.unresolved !== false })
  }
  return result
}

function importSummary(value: unknown): { rows: number; errors: number; cards: number } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const raw = value as Record<string, unknown>
  const count = (key: string) => {
    const candidate = raw[key]
    return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= MAX_CARDS
      ? candidate
      : null
  }
  const rows = count('rows')
  const errors = count('errors')
  const cardCount = count('cards')
  return rows === null || errors === null || cardCount === null ? null : { rows, errors, cards: cardCount }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const access = await accountAccess(req.headers, 'collections')
  if (access.kind !== 'ready') {
    const error = accountError(access)
    res.status(error.status).json({ error: error.error })
    return
  }

  if (req.method === 'GET') {
    const collection = await access.db
      .from('collections')
      .select('id, source_type, import_summary, created_at, updated_at')
      .eq('owner_id', access.user.id)
      .maybeSingle()
    if (collection.error) {
      res.status(503).json({ error: 'Collection service is temporarily unavailable.' })
      return
    }
    if (collection.data === null) {
      res.status(200).json({ collection: null, cards: [] })
      return
    }
    const collectionCards = await access.db
      .from('collection_cards')
      .select('name, normalized_name, scryfall_oracle_id, quantity, unresolved')
      .eq('collection_id', collection.data.id)
      .order('normalized_name', { ascending: true })
    if (collectionCards.error) {
      res.status(503).json({ error: 'Collection service is temporarily unavailable.' })
      return
    }
    res.status(200).json({ collection: collection.data, cards: collectionCards.data ?? [] })
    return
  }

  if (req.method === 'DELETE') {
    const { error } = await access.db.from('collections').delete().eq('owner_id', access.user.id)
    if (error) {
      res.status(503).json({ error: 'Collection service is temporarily unavailable.' })
      return
    }
    res.status(204).json({})
    return
  }

  if (req.method !== 'PUT') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  let body: { source?: unknown; cards?: unknown; importSummary?: unknown }
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const source = sourceType(body?.source)
  const parsedCards = cards(body?.cards)
  const summary = importSummary(body?.importSummary)
  if (source === null || parsedCards === null || summary === null) {
    res.status(400).json({ error: 'Invalid normalized collection.' })
    return
  }

  const { data, error } = await access.db.rpc('moxscore_replace_collection', {
    p_owner_id: access.user.id,
    p_source_type: source,
    p_cards: parsedCards,
    p_import_summary: summary,
  })
  if (error || data === null) {
    const status = error?.code === '22023' ? 400 : 503
    res.status(status).json({ error: status === 400 ? 'Invalid normalized collection.' : 'Collection service is temporarily unavailable.' })
    return
  }
  res.status(200).json({ collection: data })
}
