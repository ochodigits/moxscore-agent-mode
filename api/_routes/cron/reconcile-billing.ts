import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { reconcileBillingPage, ReconciliationStopError, type ReconciliationCounts } from '../../_billingReconciliation.js'
import { billingAlerts, billingOperationLimits, reconciliationMode, type BillingOperationsSummary } from '../../_billingOperations.js'
import { stripeClient } from '../../_billing.js'
import { billingOperationEnabled } from '../../_operationalFlags.js'
import { operatorAuthorized } from '../../_operatorAuth.js'
import { currentRequestId } from '../../_requestContext.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

interface StartDecision {
  acquired: boolean
  start_cursor: number
}

function serviceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  return url && key ? { url, key } : null
}

function countsForFailure(): ReconciliationCounts & { reconciliationFailures: number } {
  return {
    ...emptyCounts(),
    reconciliationFailures: 1,
  }
}

function emptyCounts(): ReconciliationCounts {
  return {
    processedCustomers: 0,
    missingLocalSubscriptions: 0,
    staleSubscriptions: 0,
    unknownPrices: 0,
    orphanedMappings: 0,
    orphanedLocalSubscriptions: 0,
    unmappedProviderSubscriptions: 0,
    multipleGrantingSubscriptions: 0,
    ownershipConflicts: 0,
    outOfOrderRegressions: 0,
    providerScanTruncated: 0,
    repaired: 0,
    unresolved: 0,
  }
}

function addCounts(target: ReconciliationCounts, page: ReconciliationCounts): void {
  for (const key of Object.keys(target) as Array<keyof ReconciliationCounts>) {
    target[key] += page[key] ?? 0
  }
}

/** Daily Vercel-Cron-compatible billing reconciliation entrypoint. */
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

  const config = serviceConfig()
  const stripe = stripeClient()
  if (config === null || stripe === null) {
    res.status(503).json({ error: 'Billing reconciliation is temporarily unavailable.' })
    return
  }

  const mode = reconciliationMode()
  if (mode === 'repair' && !billingOperationEnabled('repair')) {
    res.status(503).json({ error: 'Billing repair is disabled.' })
    return
  }

  const db = createClient(config.url, config.key, { auth: { persistSession: false } })
  const limits = billingOperationLimits()
  const requestId = currentRequestId()
  const runId = typeof requestId === 'string' && requestId.length >= 16 && requestId.length <= 100
    ? requestId
    : randomUUID()
  let startCursor = 0
  let leaseAcquired = false
  try {
    const started = await db.rpc('moxscore_start_billing_reconciliation', {
      p_run_id: runId,
      p_mode: mode,
      p_lease_seconds: limits.leaseSeconds,
    })
    if (started.error) throw new Error('reconciliation lease unavailable')
    const decision = (Array.isArray(started.data) ? started.data[0] : started.data) as StartDecision | null
    if (decision === null) throw new Error('invalid reconciliation lease')
    startCursor = Number(decision.start_cursor) || 0
    if (!decision.acquired) {
      res.status(200).json({ status: 'skipped_overlap' })
      return
    }
    leaseAcquired = true

    const deadline = Date.now() + limits.maxRuntimeMs
    const counts = emptyCounts()
    let nextCursor = startCursor
    let hasMore = true
    let pages = 0
    do {
      const result = await reconcileBillingPage(stripe, db, {
        startCursor: nextCursor,
        batchSize: limits.batchSize,
        providerScanLimit: limits.providerScanLimit,
        mode,
        observedAt: new Date().toISOString(),
      })
      addCounts(counts, result.counts)
      nextCursor = result.nextCursor
      hasMore = result.hasMore
      pages += 1
    } while (hasMore && pages < limits.maxPages && Date.now() < deadline)

    const finished = await db.rpc('moxscore_finish_billing_reconciliation', {
      p_run_id: runId,
      p_status: 'succeeded',
      p_next_cursor: nextCursor,
      p_has_more: hasMore,
      p_counts: counts,
    })
    if (finished.error) throw new Error('reconciliation checkpoint failed')
    leaseAcquired = false

    const summaryResult = await db.rpc('moxscore_billing_operations_summary', {
      p_webhook_stale_seconds: limits.webhookStaleSeconds,
    })
    if (summaryResult.error || summaryResult.data === null) throw new Error('billing signals unavailable')
    const summary = summaryResult.data as BillingOperationsSummary
    const alerts = billingAlerts(summary, Date.now(), limits.reconciliationStaleMs)
    const requiresAction = counts.unresolved > 0
      || alerts.webhookBacklog
      || alerts.reconciliationFailed
      || alerts.drift

    const log = requiresAction ? console.warn : console.info
    log('[billing-reconciliation]', {
      request_id: runId,
      mode,
      pages,
      has_more: hasMore,
      counts,
      alerts,
    })
    res.status(requiresAction ? 409 : 200).json({
      status: requiresAction ? 'action_required' : 'succeeded',
      mode,
      pages,
      has_more: hasMore,
      counts,
      alerts,
    })
  } catch (error) {
    const counts = countsForFailure()
    if (error instanceof ReconciliationStopError) counts.ownershipConflicts = 1
    if (leaseAcquired) {
      try {
        await db.rpc('moxscore_finish_billing_reconciliation', {
          p_run_id: runId,
          p_status: 'failed',
          p_next_cursor: startCursor,
          p_has_more: true,
          p_counts: counts,
        })
      } catch {
        // A database outage can also prevent checkpointing; the lease expires.
      }
    }
    console.error('[billing-reconciliation]', {
      request_id: runId,
      outcome: error instanceof ReconciliationStopError ? error.code : 'failed',
    })
    res.status(error instanceof ReconciliationStopError ? 409 : 503).json({
      error: error instanceof ReconciliationStopError
        ? 'Billing reconciliation stopped on an ownership conflict.'
        : 'Billing reconciliation is temporarily unavailable.',
    })
  }
}
