import { createClient } from '@supabase/supabase-js'
import { requireUser } from '../_auth.js'
import { serverFeatureEnabled } from '../_featureFlags.js'
import { AI_BURST_LIMITS, resolveEntitlement } from '../_entitlement.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

interface Profile {
  id: string
  display_name: string | null
  locale: string
  created_at: string
  updated_at: string
  deletion_requested_at: string | null
}

function serviceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  return url && key ? { url, key } : null
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!serverFeatureEnabled('accounts')) {
    res.status(404).json({ error: 'Not available' })
    return
  }

  const auth = await requireUser(req.headers)
  if (auth.kind === 'unauthenticated') {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  if (auth.kind === 'unavailable') {
    res.status(503).json({ error: 'Account service is temporarily unavailable.' })
    return
  }

  const config = serviceConfig()
  if (config === null) {
    res.status(503).json({ error: 'Account service is temporarily unavailable.' })
    return
  }

  try {
    const db = createClient(config.url, config.key, { auth: { persistSession: false } })
    const { data, error } = await db
      .from('profiles')
      .select('id, display_name, locale, created_at, updated_at, deletion_requested_at')
      .eq('id', auth.user.id)
      .maybeSingle()
    if (error) throw error

    let profile = data as Profile | null
    if (profile === null) {
      const inserted = await db
        .from('profiles')
        .insert({ id: auth.user.id })
        .select('id, display_name, locale, created_at, updated_at, deletion_requested_at')
        .single()
      if (inserted.error || inserted.data === null) throw inserted.error ?? new Error('Profile creation failed')
      profile = inserted.data as Profile
    }

    // Entitlement is resolved server-side and returned as derived booleans.
    // A resolution outage must not silently downgrade a paying customer, so
    // the response says so explicitly and the browser shows no plan change.
    const entitlement = await resolveEntitlement(db, auth.user.id)
    if (entitlement.kind === 'unavailable') {
      res.status(503).json({ error: 'Entitlement service is temporarily unavailable.' })
      return
    }

    let aiQuota = {
      monthly_limit: 0,
      monthly_used: 0,
      monthly_remaining: 0,
      daily_limit: 0,
      daily_used: 0,
      daily_remaining: 0,
    }
    if (entitlement.entitlement.capabilities.ai_explanations) {
      const quota = await db.rpc('moxscore_ai_quota_summary', {
        p_owner_id: auth.user.id,
        p_monthly_limit: entitlement.entitlement.limits.aiSessionsPerMonth,
        p_daily_limit: AI_BURST_LIMITS.perDay,
      })
      if (quota.error || quota.data === null) {
        res.status(503).json({ error: 'AI quota service is temporarily unavailable.' })
        return
      }
      aiQuota = quota.data as typeof aiQuota
    }

    res.status(200).json({
      profile,
      plan: entitlement.entitlement.plan,
      capabilities: entitlement.entitlement.capabilities,
      limits: entitlement.entitlement.limits,
      period_end: entitlement.entitlement.periodEnd,
      cancel_at_period_end: entitlement.entitlement.cancelAtPeriodEnd,
      quotas: { ai_explanations: aiQuota },
    })
  } catch {
    // The response intentionally has no provider details, user input, token,
    // or database payload. The free analyzer remains entirely local.
    res.status(503).json({ error: 'Account service is temporarily unavailable.' })
  }
}
