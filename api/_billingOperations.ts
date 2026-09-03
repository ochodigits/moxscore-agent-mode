type ServerEnv = Record<string, string | undefined>

export interface BillingOperationLimits {
  batchSize: number
  leaseSeconds: number
  maxPages: number
  maxRuntimeMs: number
  providerScanLimit: number
  webhookStaleSeconds: number
  reconciliationStaleMs: number
}

export interface BillingOperationsSummary {
  unprocessed_webhooks: number
  stale_webhooks: number
  failed_webhooks: number
  oldest_unprocessed_at: string | null
  last_attempt_at: string | null
  last_page_success_at: string | null
  last_full_success_at: string | null
  last_failure_at: string | null
  last_status: 'succeeded' | 'failed' | 'skipped_overlap' | null
  last_counts: Record<string, number>
  next_customer_key: number
  run_in_progress: boolean
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

export function billingOperationLimits(env: ServerEnv = process.env): BillingOperationLimits {
  const leaseSeconds = boundedInteger(env.MOXSCORE_BILLING_RECONCILIATION_LEASE_SECONDS, 300, 30, 900)
  const requestedRuntimeSeconds = boundedInteger(env.MOXSCORE_BILLING_RECONCILIATION_MAX_RUNTIME_SECONDS, 240, 15, 840)
  return {
    batchSize: boundedInteger(env.MOXSCORE_BILLING_RECONCILIATION_BATCH_SIZE, 25, 1, 100),
    leaseSeconds,
    maxPages: boundedInteger(env.MOXSCORE_BILLING_RECONCILIATION_MAX_PAGES, 20, 1, 100),
    maxRuntimeMs: Math.min(requestedRuntimeSeconds, Math.max(15, leaseSeconds - 10)) * 1000,
    providerScanLimit: boundedInteger(env.MOXSCORE_BILLING_PROVIDER_SCAN_LIMIT, 500, 100, 2_000),
    webhookStaleSeconds: boundedInteger(env.MOXSCORE_WEBHOOK_STALE_SECONDS, 600, 60, 86_400),
    reconciliationStaleMs:
      boundedInteger(env.MOXSCORE_RECONCILIATION_STALE_HOURS, 26, 1, 168) * 60 * 60 * 1000,
  }
}

export function reconciliationMode(env: ServerEnv = process.env): 'dry_run' | 'repair' {
  return env.MOXSCORE_BILLING_RECONCILIATION_MODE === 'repair' ? 'repair' : 'dry_run'
}

export function billingAlerts(
  summary: BillingOperationsSummary,
  nowMs = Date.now(),
  staleReconciliationMs = 26 * 60 * 60 * 1000,
): { webhookBacklog: boolean; reconciliationFailed: boolean; reconciliationStale: boolean; drift: boolean } {
  const lastSuccess = summary.last_full_success_at === null ? Number.NaN : Date.parse(summary.last_full_success_at)
  const driftCount = Object.entries(summary.last_counts)
    .filter(([key]) => key !== 'processedCustomers' && key !== 'repaired')
    .reduce((total, [, value]) => total + (Number.isFinite(value) ? value : 0), 0)
  return {
    webhookBacklog: summary.stale_webhooks > 0 || summary.failed_webhooks > 0,
    reconciliationFailed: summary.last_status === 'failed',
    reconciliationStale: !Number.isFinite(lastSuccess) || nowMs - lastSuccess > staleReconciliationMs,
    drift: driftCount > 0,
  }
}
