import { createClient } from '@supabase/supabase-js'
import { logSupabaseError } from '../../_supabaseErrors.js'
import { serverFeatureEnabled } from '../../_featureFlags.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

/** Vercel Cron invokes this daily with Authorization: Bearer $CRON_SECRET. */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const secret = process.env.CRON_SECRET?.trim() ?? ''
  const authorization = req.headers?.authorization
  const supplied = Array.isArray(authorization) ? authorization[0] : authorization
  if (!secret) {
    res.status(503).json({ error: 'Scheduled maintenance is not configured.' })
    return
  }
  if (supplied !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (!url || !key) {
    res.status(503).json({ error: 'Storage is not configured.' })
    return
  }
  try {
    const db = createClient(url, key, { auth: { persistSession: false } })
    const { error } = await db.from('shared_decks').delete().lt('expires_at', new Date().toISOString())
    if (error) throw error
    let aiExplanationsPurged = 0
    if (serverFeatureEnabled('proAi')) {
      const pruned = await db.rpc('moxscore_prune_ai_explanations', { p_limit: 500 })
      if (pruned.error) throw pruned.error
      aiExplanationsPurged = Number(pruned.data) || 0
    }
    res.status(200).json({ ok: true, aiExplanationsPurged })
  } catch (error) {
    logSupabaseError('/api/cron/purge-expired-shares', 'delete', error)
    res.status(503).json({ error: 'Share cleanup is temporarily unavailable.' })
  }
}
