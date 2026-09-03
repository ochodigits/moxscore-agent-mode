import { describe, expect, it, vi } from 'vitest'
import { reconcileBillingPage, ReconciliationStopError } from './_billingReconciliation'

interface Mapping {
  owner_id: string
  provider_customer_id: string
  reconciliation_key: number
}

interface LocalRow {
  provider_subscription_id: string
  owner_id: string
  status: string
  price_key: string
  current_period_end: string | null
  cancel_at_period_end: boolean
  reconciliation_blocked: boolean
  last_event_at: string
}

const OBSERVED = '2026-08-23T10:00:00.000Z'
const PERIOD = Math.floor(Date.parse('2026-09-23T10:00:00.000Z') / 1000)
const env = {
  VERCEL_ENV: 'preview',
  STRIPE_PRICE_PRO_MONTHLY: 'price_monthly',
  STRIPE_PRICE_PRO_ANNUAL: 'price_annual',
}

function providerSubscription(
  id: string,
  customer: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    customer,
    status: 'active',
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_monthly' }, current_period_end: PERIOD }] },
    ...overrides,
  }
}

function localSubscription(
  id: string,
  ownerId: string,
  overrides: Partial<LocalRow> = {},
): LocalRow {
  return {
    provider_subscription_id: id,
    owner_id: ownerId,
    status: 'active',
    price_key: 'pro_monthly',
    current_period_end: new Date(PERIOD * 1000).toISOString(),
    cancel_at_period_end: false,
    reconciliation_blocked: false,
    last_event_at: '2026-08-23T09:00:00.000Z',
    ...overrides,
  }
}

function makeStripe(input: {
  subscriptionsByCustomer?: Record<string, ReturnType<typeof providerSubscription>[]>
  deletedCustomers?: string[]
  globalSubscriptions?: ReturnType<typeof providerSubscription>[]
  failCustomer?: string
}) {
  const byCustomer = input.subscriptionsByCustomer ?? {}
  function page(values: ReturnType<typeof providerSubscription>[], params: { starting_after?: string; limit?: number }) {
    const start = params.starting_after === undefined
      ? 0
      : Math.max(0, values.findIndex((item) => item.id === params.starting_after) + 1)
    const limit = params.limit ?? 100
    const data = values.slice(start, start + limit)
    return { data, has_more: start + data.length < values.length }
  }
  return {
    customers: {
      retrieve: vi.fn(async (customerId: string) => {
        if (input.failCustomer === customerId) throw new Error('Stripe unavailable')
        return input.deletedCustomers?.includes(customerId) ? { id: customerId, deleted: true } : { id: customerId }
      }),
    },
    subscriptions: {
      list: vi.fn(async (params: { customer?: string; starting_after?: string; limit?: number }) =>
        page(params.customer === undefined ? (input.globalSubscriptions ?? Object.values(byCustomer).flat()) : (byCustomer[params.customer] ?? []), params)),
    },
  }
}

function makeDb(initialMappings: Mapping[], initialSubscriptions: LocalRow[] = []) {
  const mappings = [...initialMappings]
  const subscriptions = [...initialSubscriptions]
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === 'moxscore_reconcile_subscription') {
      const next = localSubscription(params.p_subscription_id as string, params.p_owner_id as string, {
        status: params.p_status as string,
        price_key: params.p_price_key as string,
        current_period_end: params.p_current_period_end as string | null,
        cancel_at_period_end: params.p_cancel_at_period_end as boolean,
        reconciliation_blocked: params.p_reconciliation_blocked as boolean,
        last_event_at: params.p_observed_at as string,
      })
      const index = subscriptions.findIndex((row) => row.provider_subscription_id === next.provider_subscription_id)
      if (index === -1) subscriptions.push(next)
      else subscriptions[index] = next
      return { data: true, error: null }
    }
    if (name === 'moxscore_set_owner_reconciliation_block') {
      for (const row of subscriptions) {
        if (row.owner_id === params.p_owner_id) row.reconciliation_blocked = params.p_blocked as boolean
      }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
  const from = (table: string) => {
    let gtCursor = 0
    const builder = {
      select: () => builder,
      gt: (_field: string, value: number) => { gtCursor = value; return builder },
      order: () => builder,
      limit: async (limit: number) => ({
        data: mappings.filter((row) => row.reconciliation_key > gtCursor).toSorted((a, b) => a.reconciliation_key - b.reconciliation_key).slice(0, limit),
        error: null,
      }),
      in: async (field: string, values: string[]) => {
        if (table === 'subscriptions') {
          return { data: subscriptions.filter((row) => values.includes(row[field as keyof LocalRow] as string)), error: null }
        }
        return { data: mappings.filter((row) => values.includes(row[field as keyof Mapping] as string)), error: null }
      },
    }
    return builder
  }
  return { db: { from, rpc } as never, rpc, subscriptions }
}

function mapping(index: number): Mapping {
  return { owner_id: `owner-${index}`, provider_customer_id: `cus_${index}`, reconciliation_key: index }
}

async function run(
  stripe: ReturnType<typeof makeStripe>,
  db: ReturnType<typeof makeDb>['db'],
  mode: 'dry_run' | 'repair' = 'dry_run',
  overrides: Partial<{ startCursor: number; batchSize: number; providerScanLimit: number }> = {},
) {
  return reconcileBillingPage(stripe as never, db, {
    startCursor: overrides.startCursor ?? 0,
    batchSize: overrides.batchSize ?? 25,
    providerScanLimit: overrides.providerScanLimit ?? 500,
    mode,
    observedAt: OBSERVED,
    env,
  })
}

describe('billing reconciliation', () => {
  it('reports missing local state in dry-run without writing', async () => {
    const stripe = makeStripe({ subscriptionsByCustomer: { cus_1: [providerSubscription('sub_1', 'cus_1')] } })
    const state = makeDb([mapping(1)])
    const result = await run(stripe, state.db)
    expect(result.counts.missingLocalSubscriptions).toBe(1)
    expect(result.counts.repaired).toBe(0)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('places a fail-closed owner block when dry-run finds stale granting state', async () => {
    const stripe = makeStripe({ subscriptionsByCustomer: {
      cus_1: [providerSubscription('sub_1', 'cus_1', { status: 'canceled' })],
    } })
    const state = makeDb([mapping(1)], [localSubscription('sub_1', 'owner-1')])
    const result = await run(stripe, state.db)
    expect(result.counts.staleSubscriptions).toBe(1)
    expect(state.rpc).toHaveBeenCalledWith('moxscore_set_owner_reconciliation_block', {
      p_owner_id: 'owner-1', p_blocked: true,
    })
  })

  it('repairs authoritative state idempotently', async () => {
    const stripe = makeStripe({ subscriptionsByCustomer: { cus_1: [providerSubscription('sub_1', 'cus_1')] } })
    const state = makeDb([mapping(1)])
    expect((await run(stripe, state.db, 'repair')).counts.repaired).toBe(1)
    state.rpc.mockClear()
    expect((await run(stripe, state.db, 'repair')).counts.repaired).toBe(0)
    expect(state.rpc.mock.calls.filter((call) => call[0] === 'moxscore_reconcile_subscription')).toHaveLength(0)
  })

  it('uses a resumable keyset cursor and defers the global scan until the final page', async () => {
    const stripe = makeStripe({ subscriptionsByCustomer: {} })
    const state = makeDb([mapping(1), mapping(2), mapping(3)])
    const first = await run(stripe, state.db, 'dry_run', { batchSize: 2 })
    expect(first).toMatchObject({ hasMore: true, nextCursor: 2 })
    expect(stripe.subscriptions.list).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'all', customer: undefined }))
    const second = await run(stripe, state.db, 'dry_run', { batchSize: 2, startCursor: first.nextCursor })
    expect(second).toMatchObject({ hasMore: false, nextCursor: 0 })
  })

  it('blocks unknown prices, multiple grants, orphaned local rows, and future event regressions', async () => {
    const first = providerSubscription('sub_1', 'cus_1')
    const second = providerSubscription('sub_2', 'cus_1')
    const unknown = providerSubscription('sub_3', 'cus_1', {
      items: { data: [{ price: { id: 'price_other' }, current_period_end: PERIOD }] },
    })
    const stripe = makeStripe({ subscriptionsByCustomer: { cus_1: [first, second, unknown] } })
    const state = makeDb([mapping(1)], [
      localSubscription('sub_1', 'owner-1', { last_event_at: '2026-08-23T11:00:00.000Z' }),
      localSubscription('sub_orphan', 'owner-1'),
    ])
    const result = await run(stripe, state.db, 'repair')
    expect(result.counts).toMatchObject({
      unknownPrices: 1,
      multipleGrantingSubscriptions: 1,
      orphanedLocalSubscriptions: 1,
      outOfOrderRegressions: 1,
      unresolved: 1,
    })
    expect(state.rpc).toHaveBeenCalledWith('moxscore_set_owner_reconciliation_block', {
      p_owner_id: 'owner-1', p_blocked: true,
    })
  })

  it('detects a deleted provider customer as an orphaned mapping', async () => {
    const stripe = makeStripe({ deletedCustomers: ['cus_1'] })
    const state = makeDb([mapping(1)], [localSubscription('sub_1', 'owner-1')])
    const result = await run(stripe, state.db, 'repair')
    expect(result.counts.orphanedMappings).toBe(1)
    expect(result.counts.unresolved).toBe(1)
  })

  it('stops rather than rebinding a subscription owned by another account', async () => {
    const stripe = makeStripe({ subscriptionsByCustomer: { cus_1: [providerSubscription('sub_1', 'cus_1')] } })
    const state = makeDb([mapping(1), mapping(2)], [localSubscription('sub_1', 'owner-2')])
    await expect(run(stripe, state.db, 'repair')).rejects.toBeInstanceOf(ReconciliationStopError)
    expect(state.rpc).not.toHaveBeenCalledWith('moxscore_reconcile_subscription', expect.anything())
  })

  it('detects unmapped global provider subscriptions and propagates provider outages', async () => {
    const external = providerSubscription('sub_external', 'cus_external')
    const stripe = makeStripe({ subscriptionsByCustomer: { cus_1: [] }, globalSubscriptions: [external] })
    const state = makeDb([mapping(1)])
    expect((await run(stripe, state.db)).counts.unmappedProviderSubscriptions).toBe(1)

    const failedStripe = makeStripe({ failCustomer: 'cus_1' })
    await expect(run(failedStripe, state.db)).rejects.toThrow('Stripe unavailable')
  })

  it('ignores unrelated products when scanning a shared Stripe account', async () => {
    const unrelated = providerSubscription('sub_unrelated', 'cus_external', {
      items: { data: [{ price: { id: 'price_other_product' }, current_period_end: PERIOD }] },
    })
    const stripe = makeStripe({ subscriptionsByCustomer: { cus_1: [] }, globalSubscriptions: [unrelated] })
    const state = makeDb([mapping(1)])
    expect((await run(stripe, state.db)).counts.unmappedProviderSubscriptions).toBe(0)
  })
})
