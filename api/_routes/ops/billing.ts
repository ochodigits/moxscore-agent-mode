import { createClient } from '@supabase/supabase-js'
import { billingAlerts, billingOperationLimits, type BillingOperationsSummary } from '../../_billingOperations.js'
import { billingOperationEnabled } from '../../_operationalFlags.js'
import { operatorAuthorized } from '../../_operatorAuth.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!billingOperationEnabled('reconciliation')) {
    res.status(404).json({ error: 'Not available' })
    return
  }
  if (!operatorAuthorized(req.headers)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (!url || !key) {
    res.status(503).json({ error: 'Billing operations are temporarily unavailable.' })
    return
  }

  const limits = billingOperationLimits()
  try {
    const db = createClient(url, key, { auth: { persistSession: false } })
    const result = await db.rpc('moxscore_billing_operations_summary', {
      p_webhook_stale_seconds: limits.webhookStaleSeconds,
    })
    if (result.error || result.data === null) throw new Error('summary unavailable')
    const summary = result.data as BillingOperationsSummary
    res.status(200).json({
      summary,
      alerts: billingAlerts(summary, Date.now(), limits.reconciliationStaleMs),
      thresholds: {
        webhook_stale_seconds: limits.webhookStaleSeconds,
        reconciliation_stale_hours: limits.reconciliationStaleMs / 3_600_000,
      },
    })
  } catch {
    res.status(503).json({ error: 'Billing operations are temporarily unavailable.' })
  }
}
