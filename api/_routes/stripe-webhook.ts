import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { serverFeatureEnabled } from '../_featureFlags.js'
import { periodEndFrom, priceKeyFrom, stripeClient, webhookSecret } from '../_billing.js'
import { billingOperationEnabled } from '../_operationalFlags.js'

interface VercelReq {
  method?: string
  body?: unknown
  /** Exact bytes as delivered, supplied by the catch-all router. */
  rawBody?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

/**
 * Subscription lifecycle events. Each is projected by re-reading the
 * subscription object, so an out-of-order or partial event can never write a
 * status the provider no longer reports.
 */
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
])

/** Invoice and dispute events that imply a subscription state change. */
const INVOICE_EVENTS = new Set([
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
])

function headerValue(headers: VercelReq['headers'], name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function serviceDb(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

/** Resolves ownership from our own customer table, never from event metadata. */
async function ownerFor(db: SupabaseClient, customerId: string): Promise<string | null> {
  const { data, error } = await db
    .from('billing_customers')
    .select('owner_id')
    .eq('provider_customer_id', customerId)
    .maybeSingle()
  if (error || !data) return null
  return (data.owner_id as string) ?? null
}

async function projectSubscription(
  db: SupabaseClient,
  subscription: Stripe.Subscription,
  eventAt: string,
): Promise<'processed' | 'ignored'> {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
  if (!customerId) return 'ignored'

  const ownerId = await ownerFor(db, customerId)
  // An unknown customer is not an error: it may belong to another environment
  // sharing the same Stripe account. Recording it as processed prevents an
  // endless redelivery loop.
  if (ownerId === null) return 'ignored'

  const { error } = await db.rpc('moxscore_project_subscription', {
    p_subscription_id: subscription.id,
    p_customer_id: customerId,
    p_owner_id: ownerId,
    p_price_key: priceKeyFrom(subscription),
    p_status: subscription.status,
    p_current_period_end: periodEndFrom(subscription),
    p_cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    p_event_at: eventAt,
  })
  if (error) throw new Error('projection failed')
  return 'processed'
}

/**
 * Stripe webhook receiver.
 *
 * The signature is the only authentication: there is no bearer token and no
 * user session. Verification runs against `rawBody` — the exact delivered
 * bytes — because re-serializing parsed JSON changes key order and escaping
 * and invalidates the signature.
 *
 * Every event is claimed in the webhook_events ledger before any side effect,
 * so a redelivery returns 200 without repeating work.
 */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (!serverFeatureEnabled('billing')) {
    res.status(404).json({ error: 'Not available' })
    return
  }

  const stripe = stripeClient()
  const secret = webhookSecret()
  const signature = headerValue(req.headers, 'stripe-signature')
  const raw = typeof req.rawBody === 'string' ? req.rawBody : typeof req.body === 'string' ? req.body : null

  if (stripe === null || secret === null) {
    res.status(503).json({ error: 'Billing is temporarily unavailable.' })
    return
  }
  if (!signature || raw === null) {
    res.status(400).json({ error: 'Invalid signature' })
    return
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret)
  } catch {
    // Unverified payloads are rejected before they can touch storage.
    res.status(400).json({ error: 'Invalid signature' })
    return
  }

  // A deliberate non-2xx after signature verification tells Stripe to retry.
  // Never acknowledge a valid paid event while projection is disabled.
  if (!billingOperationEnabled('webhookProjection')) {
    res.status(503).json({ error: 'Webhook projection is temporarily unavailable.' })
    return
  }

  const db = serviceDb()
  if (db === null) {
    // 503 so Stripe retries once storage is reachable again.
    res.status(503).json({ error: 'Billing is temporarily unavailable.' })
    return
  }

  try {
    const claim = await db.rpc('moxscore_claim_webhook_event', {
      p_event_id: event.id,
      p_event_type: event.type,
    })
    if (claim.error) throw new Error('ledger unavailable')
    if (claim.data === 'duplicate_processed') {
      // Already completed. Acknowledge without repeating side effects.
      res.status(200).json({ received: true, duplicate: true })
      return
    }
    if (claim.data === 'retry_later') {
      // Another delivery owns the live lease. A retryable response prevents a
      // crashed first worker from turning a later delivery into a lost event.
      res.status(503).json({ error: 'Webhook processing is already in progress.' })
      return
    }
    if (claim.data !== 'claimed') throw new Error('invalid ledger decision')

    // Every supported event is converted into a fresh provider read. The
    // observation time, rather than the payload's creation time, orders that
    // authoritative read against reconciliation and other deliveries.
    const observedAt = new Date().toISOString()
    let result: 'processed' | 'ignored' = 'ignored'

    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const subscriptionId = (event.data.object as Stripe.Subscription).id
      if (subscriptionId) {
        const fresh = await stripe.subscriptions.retrieve(subscriptionId)
        result = await projectSubscription(db, fresh, observedAt)
      }
    } else if (INVOICE_EVENTS.has(event.type)) {
      // Re-read rather than trusting the invoice's embedded snapshot, which
      // can lag the subscription's real status.
      const object = event.data.object as { subscription?: string | Stripe.Subscription }
      const subscriptionId =
        typeof object.subscription === 'string' ? object.subscription : object.subscription?.id
      if (subscriptionId) {
        const fresh = await stripe.subscriptions.retrieve(subscriptionId)
        result = await projectSubscription(db, fresh, observedAt)
      }
    }

    const completed = await db.rpc('moxscore_complete_webhook_event', { p_event_id: event.id, p_result: result })
    if (completed.error) throw new Error('ledger completion failed')
    res.status(200).json({ received: true })
  } catch {
    // Mark the attempt failed and return 500 so Stripe retries. Failed rows are
    // independently counted by the billing-operations backlog signal.
    try {
      await db.rpc('moxscore_complete_webhook_event', { p_event_id: event.id, p_result: 'failed' })
    } catch {
      // Ledger is unreachable; the retry will re-attempt the whole event.
    }
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}
