import { accountAccess, accountError } from '../_account.js'
import { resolveEntitlement } from '../_entitlement.js'

const MAX_NAME_LENGTH = 200

interface VercelReq {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

function deckName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null
}

function databaseError(error: { code?: string } | null): { status: number; error: string } {
  if (error?.code === 'P0001') return { status: 409, error: 'Saved deck limit reached.' }
  return { status: 503, error: 'Saved decks are temporarily unavailable.' }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const access = await accountAccess(req.headers, 'persistence')
  if (access.kind !== 'ready') {
    const error = accountError(access)
    res.status(error.status).json({ error: error.error })
    return
  }

  if (req.method === 'GET') {
    const { data, error } = await access.db
      .from('saved_decks')
      .select('id, name, format, current_version_id, created_at, updated_at, archived_at')
      .eq('owner_id', access.user.id)
      .order('updated_at', { ascending: false })
    if (error) {
      const response = databaseError(error)
      res.status(response.status).json({ error: response.error })
      return
    }
    res.status(200).json({ decks: data ?? [] })
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  let body: { name?: unknown; format?: unknown }
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const name = deckName(body?.name)
  if (name === null || (body?.format !== undefined && body.format !== 'commander')) {
    res.status(400).json({ error: 'Provide a deck name up to 200 characters in Commander format.' })
    return
  }

  // Limit comes from server entitlement, never from the request body.
  const entitlement = await resolveEntitlement(access.db, access.user.id)
  if (entitlement.kind === 'unavailable') {
    res.status(503).json({ error: 'Saved decks are temporarily unavailable.' })
    return
  }

  const { data, error } = await access.db.rpc('moxscore_create_saved_deck', {
    p_owner_id: access.user.id,
    p_name: name,
    p_format: 'commander',
    p_limit: entitlement.entitlement.limits.savedDecks,
  })
  if (error || data === null) {
    const response = databaseError(error)
    res.status(response.status).json({ error: response.error })
    return
  }
  res.status(201).json({ deck: data })
}
