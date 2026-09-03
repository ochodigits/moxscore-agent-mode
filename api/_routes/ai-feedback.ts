import { accountAccess, accountError } from '../_account.js'
import { requireCapability, resolveEntitlement } from '../_entitlement.js'

interface VercelReq {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}
interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REASONS = new Set(['helpful', 'irrelevant', 'unclear', 'unsupported', 'too_generic'])

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const access = await accountAccess(req.headers, 'proAi')
  if (access.kind !== 'ready') {
    const { status, error } = accountError(access)
    res.status(status).json({ error })
    return
  }
  const capability = requireCapability(await resolveEntitlement(access.db, access.user.id), 'ai_explanations')
  if (!capability.ok) {
    res.status(capability.status).json({ error: capability.error })
    return
  }

  let raw: unknown = req.body
  try {
    if (typeof raw === 'string') raw = JSON.parse(raw)
  } catch {
    res.status(400).json({ error: 'Invalid feedback.' })
    return
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    res.status(400).json({ error: 'Invalid feedback.' })
    return
  }
  const body = raw as Record<string, unknown>
  if (
    Object.keys(body).some((key) => !['requestId', 'rating', 'reasonCode'].includes(key))
    || typeof body.requestId !== 'string'
    || !REQUEST_ID.test(body.requestId)
    || (body.rating !== 'up' && body.rating !== 'down')
    || (body.reasonCode !== null && (typeof body.reasonCode !== 'string' || !REASONS.has(body.reasonCode)))
  ) {
    res.status(400).json({ error: 'Invalid feedback.' })
    return
  }

  const result = await access.db.rpc('moxscore_record_ai_feedback', {
    p_owner_id: access.user.id,
    p_request_id: body.requestId.toLowerCase(),
    p_rating: body.rating,
    p_reason_code: body.reasonCode,
  })
  if (result.error) {
    res.status(result.error.code === 'P0002' ? 404 : 503).json({
      error: result.error.code === 'P0002' ? 'Explanation not found.' : 'Feedback is temporarily unavailable.',
    })
    return
  }
  res.status(200).json({ recorded: true })
}
