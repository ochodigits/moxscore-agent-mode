import { accountAccess, accountError, isUuid } from '../_account.js'

const MAX_NAME_LENGTH = 200

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

function idFrom(req: VercelReq, body?: { id?: unknown }): string | null {
  const query = req.query?.id
  const candidate = typeof query === 'string' ? query : body?.id
  return isUuid(candidate) ? candidate : null
}

function newName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const access = await accountAccess(req.headers, 'persistence')
  if (access.kind !== 'ready') {
    const error = accountError(access)
    res.status(error.status).json({ error: error.error })
    return
  }

  if (req.method === 'GET') {
    const id = idFrom(req)
    if (id === null) {
      res.status(400).json({ error: 'Invalid saved deck id' })
      return
    }
    const { data, error } = await access.db
      .from('saved_decks')
      .select('id, name, format, current_version_id, created_at, updated_at, archived_at')
      .eq('id', id)
      .eq('owner_id', access.user.id)
      .maybeSingle()
    if (error) {
      res.status(503).json({ error: 'Saved decks are temporarily unavailable.' })
      return
    }
    if (data === null) {
      res.status(404).json({ error: 'Saved deck not found' })
      return
    }
    res.status(200).json({ deck: data })
    return
  }

  let body: { id?: unknown; name?: unknown; archived?: unknown }
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const id = idFrom(req, body)
  if (id === null) {
    res.status(400).json({ error: 'Invalid saved deck id' })
    return
  }

  if (req.method === 'PATCH') {
    const name = newName(body?.name)
    if (name === null || (body?.archived !== undefined && typeof body.archived !== 'boolean') || (name === undefined && body?.archived === undefined)) {
      res.status(400).json({ error: 'Provide a valid deck name or archived state.' })
      return
    }
    const patch: { name?: string; archived_at?: string | null } = {}
    if (name !== undefined) patch.name = name
    if (typeof body.archived === 'boolean') patch.archived_at = body.archived ? new Date().toISOString() : null
    const { data, error } = await access.db
      .from('saved_decks')
      .update(patch)
      .eq('id', id)
      .eq('owner_id', access.user.id)
      .select('id, name, format, current_version_id, created_at, updated_at, archived_at')
      .maybeSingle()
    if (error) {
      res.status(503).json({ error: 'Saved decks are temporarily unavailable.' })
      return
    }
    if (data === null) {
      res.status(404).json({ error: 'Saved deck not found' })
      return
    }
    res.status(200).json({ deck: data })
    return
  }

  if (req.method === 'DELETE') {
    const { data, error } = await access.db
      .from('saved_decks')
      .delete()
      .eq('id', id)
      .eq('owner_id', access.user.id)
      .select('id')
      .maybeSingle()
    if (error) {
      res.status(503).json({ error: 'Saved decks are temporarily unavailable.' })
      return
    }
    if (data === null) {
      res.status(404).json({ error: 'Saved deck not found' })
      return
    }
    res.status(204).json({})
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}
