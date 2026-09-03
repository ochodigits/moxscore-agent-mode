import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { periodEndFrom, priceKeyFrom } from './_billing.js'
import { subscriptionGrantsPro, type SubscriptionRow, type SubscriptionStatus } from './_entitlement.js'

type ServerEnv = Record<string, string | undefined>

interface BillingCustomerMapping {
  owner_id: string
  provider_customer_id: string
  reconciliation_key: number
}

interface LocalSubscription extends SubscriptionRow {
  provider_subscription_id: string
  owner_id: string
  last_event_at: string
}

interface CustomerState {
  mapping: BillingCustomerMapping
  deleted: boolean
  subscriptions: Stripe.Subscription[]
  truncated: boolean
}

export interface ReconciliationCounts {
  processedCustomers: number
  missingLocalSubscriptions: number
  staleSubscriptions: number
  unknownPrices: number
  orphanedMappings: number
  orphanedLocalSubscriptions: number
  unmappedProviderSubscriptions: number
  multipleGrantingSubscriptions: number
  ownershipConflicts: number
  outOfOrderRegressions: number
  providerScanTruncated: number
  repaired: number
  unresolved: number
}

export interface ReconciliationResult {
  counts: ReconciliationCounts
  nextCursor: number
  hasMore: boolean
}

export class ReconciliationStopError extends Error {
  readonly code: 'ownership_conflict'

  constructor(code: 'ownership_conflict') {
    super('Billing reconciliation found a cross-owner conflict.')
    this.code = code
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next
      next += 1
      output[index] = await mapper(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return output
}

async function listCustomerSubscriptions(
  stripe: Stripe,
  customerId: string,
  maxSubscriptions = 500,
): Promise<{ subscriptions: Stripe.Subscription[]; truncated: boolean }> {
  const subscriptions: Stripe.Subscription[] = []
  let startingAfter: string | undefined
  while (subscriptions.length < maxSubscriptions) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: Math.min(100, maxSubscriptions - subscriptions.length),
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    })
    subscriptions.push(...page.data)
    if (!page.has_more) return { subscriptions, truncated: false }
    const last = page.data.at(-1)
    if (last === undefined) return { subscriptions, truncated: true }
    startingAfter = last.id
  }
  return { subscriptions, truncated: true }
}

async function readCustomerState(stripe: Stripe, mapping: BillingCustomerMapping): Promise<CustomerState> {
  const customer = await stripe.customers.retrieve(mapping.provider_customer_id)
  if ((customer as Stripe.DeletedCustomer).deleted === true) {
    return { mapping, deleted: true, subscriptions: [], truncated: false }
  }
  const listed = await listCustomerSubscriptions(stripe, mapping.provider_customer_id)
  return { mapping, deleted: false, ...listed }
}

function expectedRow(subscription: Stripe.Subscription, env: ServerEnv): LocalSubscription {
  return {
    provider_subscription_id: subscription.id,
    owner_id: '',
    status: subscription.status as SubscriptionStatus,
    price_key: priceKeyFrom(subscription, env),
    current_period_end: periodEndFrom(subscription),
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    reconciliation_blocked: false,
    last_event_at: '',
  }
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return Date.parse(left) === Date.parse(right)
}

function stateDiffers(local: LocalSubscription, expected: LocalSubscription): boolean {
  return local.status !== expected.status
    || local.price_key !== expected.price_key
    || !sameInstant(local.current_period_end, expected.current_period_end)
    || local.cancel_at_period_end !== expected.cancel_at_period_end
    || local.reconciliation_blocked
}

async function setOwnerBlocked(db: SupabaseClient, ownerId: string, blocked: boolean): Promise<void> {
  const result = await db.rpc('moxscore_set_owner_reconciliation_block', {
    p_owner_id: ownerId,
    p_blocked: blocked,
  })
  if (result.error) throw new Error('reconciliation block failed')
}

async function repairSubscription(
  db: SupabaseClient,
  subscription: Stripe.Subscription,
  customerId: string,
  ownerId: string,
  observedAt: string,
  blocked: boolean,
  env: ServerEnv,
): Promise<boolean> {
  const result = await db.rpc('moxscore_reconcile_subscription', {
    p_subscription_id: subscription.id,
    p_customer_id: customerId,
    p_owner_id: ownerId,
    p_price_key: priceKeyFrom(subscription, env),
    p_status: subscription.status,
    p_current_period_end: periodEndFrom(subscription),
    p_cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    p_observed_at: observedAt,
    p_reconciliation_blocked: blocked,
  })
  if (result.error) throw new Error('reconciliation projection failed')
  return result.data === true
}

async function scanForUnmappedProviderSubscriptions(
  stripe: Stripe,
  db: SupabaseClient,
  maxSubscriptions: number,
  env: ServerEnv,
): Promise<{ unmapped: number; truncated: boolean }> {
  let scanned = 0
  let unmapped = 0
  let startingAfter: string | undefined
  while (scanned < maxSubscriptions) {
    const page = await stripe.subscriptions.list({
      status: 'all',
      limit: Math.min(100, maxSubscriptions - scanned),
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    })
    scanned += page.data.length
    // A Stripe account can host other environments/products. Only allowlisted
    // Moxscore prices belong to this reconciliation domain.
    const relevant = page.data.filter((subscription) => priceKeyFrom(subscription, env) !== 'unknown')
    const customerIds = [...new Set(relevant.flatMap((subscription) => {
      const customer = subscription.customer
      const id = typeof customer === 'string' ? customer : customer?.id
      return id ? [id] : []
    }))]
    if (customerIds.length > 0) {
      const mapped = await db
        .from('billing_customers')
        .select('provider_customer_id')
        .in('provider_customer_id', customerIds)
      if (mapped.error) throw new Error('billing mapping scan failed')
      const known = new Set((mapped.data ?? []).map((row) => row.provider_customer_id as string))
      unmapped += relevant.filter((subscription) => {
        const customer = subscription.customer
        const id = typeof customer === 'string' ? customer : customer?.id
        return id !== undefined && !known.has(id)
      }).length
    }
    if (!page.has_more) return { unmapped, truncated: false }
    const last = page.data.at(-1)
    if (last === undefined) return { unmapped, truncated: true }
    startingAfter = last.id
  }
  return { unmapped, truncated: true }
}

/**
 * Reconciles one bounded keyset page. Provider identifiers exist only in
 * memory; the durable run record receives aggregate counts and a numeric local
 * cursor. Ambiguous ownership is never auto-repaired.
 */
export async function reconcileBillingPage(
  stripe: Stripe,
  db: SupabaseClient,
  input: {
    startCursor: number
    batchSize: number
    providerScanLimit: number
    mode: 'dry_run' | 'repair'
    observedAt: string
    env?: ServerEnv
  },
): Promise<ReconciliationResult> {
  const env = input.env ?? process.env
  const counts = emptyCounts()
  const mappingResult = await db
    .from('billing_customers')
    .select('owner_id, provider_customer_id, reconciliation_key')
    .gt('reconciliation_key', input.startCursor)
    .order('reconciliation_key', { ascending: true })
    .limit(input.batchSize + 1)
  if (mappingResult.error) throw new Error('billing mappings unavailable')

  const fetchedMappings = (mappingResult.data ?? []) as BillingCustomerMapping[]
  const hasMore = fetchedMappings.length > input.batchSize
  const mappings = fetchedMappings.slice(0, input.batchSize)
  const states = await mapWithConcurrency(mappings, 4, (mapping) => readCustomerState(stripe, mapping))
  const ownerIds = states.map((state) => state.mapping.owner_id)
  const expectedIds = states.flatMap((state) => state.subscriptions.map((subscription) => subscription.id))

  const [ownerRowsResult, expectedRowsResult] = await Promise.all([
    ownerIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from('subscriptions')
        .select('provider_subscription_id, owner_id, status, price_key, current_period_end, cancel_at_period_end, reconciliation_blocked, last_event_at')
        .in('owner_id', ownerIds),
    expectedIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from('subscriptions')
        .select('provider_subscription_id, owner_id, status, price_key, current_period_end, cancel_at_period_end, reconciliation_blocked, last_event_at')
        .in('provider_subscription_id', expectedIds),
  ])
  if (ownerRowsResult.error || expectedRowsResult.error) throw new Error('subscription projection unavailable')

  const allLocal = new Map<string, LocalSubscription>()
  for (const row of [...(ownerRowsResult.data ?? []), ...(expectedRowsResult.data ?? [])] as LocalSubscription[]) {
    allLocal.set(row.provider_subscription_id, row)
  }
  const localByOwner = new Map<string, LocalSubscription[]>()
  for (const row of ownerRowsResult.data as LocalSubscription[]) {
    const rows = localByOwner.get(row.owner_id) ?? []
    rows.push(row)
    localByOwner.set(row.owner_id, rows)
  }

  for (const state of states) {
    counts.processedCustomers += 1
    const ownerId = state.mapping.owner_id
    const localRows = localByOwner.get(ownerId) ?? []
    let ambiguous = state.deleted || state.truncated
    let projectionDrift = false
    if (state.deleted) counts.orphanedMappings += 1
    if (state.truncated) counts.providerScanTruncated += 1

    const providerIds = new Set(state.subscriptions.map((subscription) => subscription.id))
    const missingProviderRows = localRows.filter((row) => !providerIds.has(row.provider_subscription_id))
    if (missingProviderRows.length > 0) {
      counts.orphanedLocalSubscriptions += missingProviderRows.length
      ambiguous = true
    }

    let granting = 0
    for (const subscription of state.subscriptions) {
      const expected = expectedRow(subscription, env)
      expected.owner_id = ownerId
      expected.last_event_at = input.observedAt
      const local = allLocal.get(subscription.id)
      if (local !== undefined && local.owner_id !== ownerId) {
        counts.ownershipConflicts += 1
        counts.unresolved += 1
        await Promise.all([setOwnerBlocked(db, ownerId, true), setOwnerBlocked(db, local.owner_id, true)])
        throw new ReconciliationStopError('ownership_conflict')
      }
      if (expected.price_key === 'unknown') {
        counts.unknownPrices += 1
        ambiguous = true
      }
      if (subscriptionGrantsPro(expected, Date.parse(input.observedAt), env)) granting += 1
      if (local === undefined) counts.missingLocalSubscriptions += 1
      else if (Date.parse(local.last_event_at) > Date.parse(input.observedAt)) {
        counts.outOfOrderRegressions += 1
        ambiguous = true
      } else if (stateDiffers(local, expected)) {
        counts.staleSubscriptions += 1
        projectionDrift = true
      }
    }
    if (granting > 1) {
      counts.multipleGrantingSubscriptions += 1
      ambiguous = true
    }

    if (ambiguous) {
      counts.unresolved += 1
      await setOwnerBlocked(db, ownerId, true)
      continue
    }

    if (input.mode === 'repair') {
      for (const subscription of state.subscriptions) {
        const local = allLocal.get(subscription.id)
        const expected = expectedRow(subscription, env)
        if (local === undefined || stateDiffers(local, expected)) {
          if (await repairSubscription(
            db,
            subscription,
            state.mapping.provider_customer_id,
            ownerId,
            input.observedAt,
            true,
            env,
          )) counts.repaired += 1
        }
      }
      await setOwnerBlocked(db, ownerId, false)
    } else if (projectionDrift) {
      // Dry-run never changes provider-derived fields, but a known mismatch
      // must not continue granting a paid capability while awaiting repair.
      await setOwnerBlocked(db, ownerId, true)
    }
  }

  if (!hasMore) {
    const providerScan = await scanForUnmappedProviderSubscriptions(stripe, db, input.providerScanLimit, env)
    counts.unmappedProviderSubscriptions = providerScan.unmapped
    if (providerScan.unmapped > 0) counts.unresolved += providerScan.unmapped
    if (providerScan.truncated) {
      counts.providerScanTruncated += 1
      counts.unresolved += 1
    }
  }

  const last = mappings.at(-1)
  return {
    counts,
    nextCursor: hasMore && last !== undefined ? last.reconciliation_key : 0,
    hasMore,
  }
}
