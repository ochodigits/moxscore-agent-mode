import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const state = vi.hoisted(() => ({
  reconciliationEnabled: true,
  repairEnabled: true,
  authorized: true,
  mode: 'dry_run' as 'dry_run' | 'repair',
  startDecision: [{ acquired: true, start_cursor: 0 }] as unknown,
  rpc: vi.fn() as Mock,
  reconcile: vi.fn() as Mock,
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: state.rpc }) }))
vi.mock('./_billing.js', () => ({ stripeClient: () => ({}) }))
vi.mock('./_operatorAuth.js', () => ({ operatorAuthorized: () => state.authorized }))
vi.mock('./_operationalFlags.js', () => ({
  billingOperationEnabled: (operation: string) =>
    operation === 'reconciliation' ? state.reconciliationEnabled : operation === 'repair' ? state.repairEnabled : false,
}))
vi.mock('./_billingOperations.js', async () => {
  const actual = await vi.importActual<typeof import('./_billingOperations')>('./_billingOperations')
  return {
    ...actual,
    billingOperationLimits: () => ({
      batchSize: 25,
      leaseSeconds: 300,
      maxPages: 20,
      maxRuntimeMs: 240_000,
      providerScanLimit: 500,
      webhookStaleSeconds: 600,
      reconciliationStaleMs: 26 * 60 * 60 * 1000,
    }),
    reconciliationMode: () => state.mode,
  }
})
vi.mock('./_billingReconciliation.js', async () => {
  const actual = await vi.importActual<typeof import('./_billingReconciliation')>('./_billingReconciliation')
  return { ...actual, reconcileBillingPage: (...args: unknown[]) => state.reconcile(...args) }
})

function recorder() {
  const result: { statusCode: number; body: unknown } = { statusCode: 0, body: null }
  const res = {
    status(code: number) { result.statusCode = code; return res },
    json(body: unknown) { result.body = body },
  }
  return { res, result }
}

async function invoke() {
  const { default: handler } = await import('./_routes/cron/reconcile-billing.js')
  const { res, result } = recorder()
  await handler({ method: 'GET', headers: { authorization: 'Bearer operator' } }, res)
  return result
}

async function invokeOps() {
  const { default: handler } = await import('./_routes/ops/billing.js')
  const { res, result } = recorder()
  await handler({ method: 'GET', headers: { authorization: 'Bearer operator' } }, res)
  return result
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
  state.reconciliationEnabled = true
  state.repairEnabled = true
  state.authorized = true
  state.mode = 'dry_run'
  state.startDecision = [{ acquired: true, start_cursor: 0 }]
  state.rpc = vi.fn(async (name: string) => {
    if (name === 'moxscore_start_billing_reconciliation') return { data: state.startDecision, error: null }
    if (name === 'moxscore_billing_operations_summary') return {
      data: {
        unprocessed_webhooks: 0,
        stale_webhooks: 0,
        failed_webhooks: 0,
        oldest_unprocessed_at: null,
        last_attempt_at: '2026-08-23T10:00:00Z',
        last_page_success_at: '2026-08-23T10:00:00Z',
        last_full_success_at: '2026-08-23T10:00:00Z',
        last_failure_at: null,
        last_status: 'succeeded',
        last_counts: { processedCustomers: 1, repaired: 0 },
        next_customer_key: 0,
        run_in_progress: false,
      },
      error: null,
    }
    return { data: null, error: null }
  })
  state.reconcile = vi.fn(async () => ({
    counts: { processedCustomers: 1, repaired: 0, unresolved: 0 },
    nextCursor: 0,
    hasMore: false,
  }))
})

describe('billing reconciliation route', () => {
  it('requires the independent switch and operator bearer before storage work', async () => {
    state.reconciliationEnabled = false
    expect(await invoke()).toMatchObject({ statusCode: 404 })
    state.reconciliationEnabled = true
    state.authorized = false
    expect(await invoke()).toMatchObject({ statusCode: 401, body: { error: 'Unauthorized' } })
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('runs a dry page and checkpoints only aggregate counts', async () => {
    const result = await invoke()
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({ status: 'succeeded', mode: 'dry_run', has_more: false })
    expect(state.rpc).toHaveBeenCalledWith('moxscore_finish_billing_reconciliation', expect.objectContaining({
      p_status: 'succeeded', p_next_cursor: 0, p_has_more: false,
    }))
  })

  it('processes bounded pages in one scheduled run and checkpoints their aggregate', async () => {
    state.reconcile
      .mockResolvedValueOnce({
        counts: { processedCustomers: 1, repaired: 0, unresolved: 0 },
        nextCursor: 25,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        counts: { processedCustomers: 2, repaired: 1, unresolved: 0 },
        nextCursor: 0,
        hasMore: false,
      })
    const result = await invoke()
    expect(result.body).toMatchObject({ pages: 2, has_more: false, counts: { processedCustomers: 3, repaired: 1 } })
    expect(state.rpc).toHaveBeenCalledWith('moxscore_finish_billing_reconciliation', expect.objectContaining({
      p_counts: expect.objectContaining({ processedCustomers: 3, repaired: 1 }),
    }))
  })

  it('skips a safely overlapping invocation without provider work', async () => {
    state.startDecision = [{ acquired: false, start_cursor: 42 }]
    const result = await invoke()
    expect(result).toEqual({ statusCode: 200, body: { status: 'skipped_overlap' } })
    expect(state.reconcile).not.toHaveBeenCalled()
  })

  it('requires the separate repair switch for mutating mode', async () => {
    state.mode = 'repair'
    state.repairEnabled = false
    const result = await invoke()
    expect(result).toMatchObject({ statusCode: 503, body: { error: 'Billing repair is disabled.' } })
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('records a failed run and returns retryable 503 on provider or database failure', async () => {
    state.reconcile = vi.fn(async () => { throw new Error('Stripe unavailable') })
    const result = await invoke()
    expect(result.statusCode).toBe(503)
    expect(state.rpc).toHaveBeenCalledWith('moxscore_finish_billing_reconciliation', expect.objectContaining({
      p_status: 'failed', p_has_more: true,
    }))
  })
})

describe('billing aggregate operations route', () => {
  it('requires operator authentication', async () => {
    state.authorized = false
    expect(await invokeOps()).toEqual({ statusCode: 401, body: { error: 'Unauthorized' } })
  })

  it('returns thresholds and aggregate alerts without provider or user identifiers', async () => {
    const result = await invokeOps()
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      alerts: { webhookBacklog: false, reconciliationFailed: false },
      thresholds: { webhook_stale_seconds: 600, reconciliation_stale_hours: 26 },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/cus_|sub_|owner-|@/)
  })
})
