import { describe, expect, it } from 'vitest'
import { billingAlerts, billingOperationLimits, reconciliationMode, type BillingOperationsSummary } from './_billingOperations'

const clean: BillingOperationsSummary = {
  unprocessed_webhooks: 0,
  stale_webhooks: 0,
  failed_webhooks: 0,
  oldest_unprocessed_at: null,
  last_attempt_at: '2026-08-23T10:00:00Z',
  last_page_success_at: '2026-08-23T10:00:00Z',
  last_full_success_at: '2026-08-23T10:00:00Z',
  last_failure_at: null,
  last_status: 'succeeded',
  last_counts: { processedCustomers: 2, repaired: 0 },
  next_customer_key: 0,
  run_in_progress: false,
}

describe('billing operation configuration and alerts', () => {
  it('uses bounded defaults and rejects extreme environment values', () => {
    expect(billingOperationLimits({})).toMatchObject({
      batchSize: 25,
      leaseSeconds: 300,
      maxPages: 20,
      maxRuntimeMs: 240_000,
      providerScanLimit: 500,
    })
    expect(billingOperationLimits({ MOXSCORE_BILLING_RECONCILIATION_BATCH_SIZE: '10000' }).batchSize).toBe(25)
    expect(billingOperationLimits({
      MOXSCORE_BILLING_RECONCILIATION_LEASE_SECONDS: '30',
      MOXSCORE_BILLING_RECONCILIATION_MAX_RUNTIME_SECONDS: '840',
    }).maxRuntimeMs).toBe(20_000)
  })

  it('defaults reconciliation to dry-run', () => {
    expect(reconciliationMode({})).toBe('dry_run')
    expect(reconciliationMode({ MOXSCORE_BILLING_RECONCILIATION_MODE: 'repair' })).toBe('repair')
  })

  it('makes stale webhooks and failed or stale reconciliation actionable', () => {
    const now = Date.parse('2026-08-23T11:00:00Z')
    expect(billingAlerts(clean, now)).toEqual({
      webhookBacklog: false, reconciliationFailed: false, reconciliationStale: false, drift: false,
    })
    expect(billingAlerts({ ...clean, stale_webhooks: 1 }, now).webhookBacklog).toBe(true)
    expect(billingAlerts({ ...clean, last_status: 'failed' }, now).reconciliationFailed).toBe(true)
    expect(billingAlerts({ ...clean, last_full_success_at: null }, now).reconciliationStale).toBe(true)
    expect(billingAlerts({ ...clean, last_counts: { unknownPrices: 1 } }, now).drift).toBe(true)
  })
})
