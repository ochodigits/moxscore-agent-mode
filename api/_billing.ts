// Stripe control-plane helpers.
//
// Two rules drive the shape of this module:
//
//   1. The browser never names a price. It sends a short key from the allowlist
//      below; the server resolves it to a Stripe price id. A caller cannot
//      substitute an amount, a currency, or a price from another account.
//   2. Nothing here grants a capability. Entitlement is derived in
//      api/_entitlement.ts from projected subscription state, never from a
//      Checkout redirect, a success URL, or a query parameter.

import Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'

type ServerEnv = Record<string, string | undefined>

/** The only price identifiers a client may name. */
export const PRICE_KEYS = ['pro_monthly', 'pro_annual'] as const
export type PriceKey = (typeof PRICE_KEYS)[number]

const PRICE_ENV: Record<PriceKey, string> = {
  pro_monthly: 'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual: 'STRIPE_PRICE_PRO_ANNUAL',
}

export function isPriceKey(value: unknown): value is PriceKey {
  return typeof value === 'string' && (PRICE_KEYS as readonly string[]).includes(value)
}

/** Resolves an allowlisted key to the configured Stripe price id. */
export function priceIdFor(key: PriceKey, env: ServerEnv = process.env): string | null {
  const value = env[PRICE_ENV[key]]?.trim()
  return value ? value : null
}

export function stripeClient(env: ServerEnv = process.env): Stripe | null {
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (!key) return null
  // No explicit apiVersion: the installed SDK pins one it is tested against.
  return new Stripe(key)
}

export function webhookSecret(env: ServerEnv = process.env): string | null {
  return env.STRIPE_WEBHOOK_SECRET?.trim() || null
}

export function publicOrigin(env: ServerEnv = process.env): string | null {
  const raw = env.PUBLIC_ORIGIN?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    if (url.protocol !== 'https:' && !localHttp) return null
    if (url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Returns the Stripe customer for a Moxscore user, creating one on first use.
 *
 * One customer per account, reused forever, so a returning subscriber does not
 * accumulate duplicate customers and the portal shows their full history.
 */
export async function ensureCustomer(
  stripe: Stripe,
  db: SupabaseClient,
  userId: string,
  email: string | null,
): Promise<string | null> {
  const existing = await db
    .from('billing_customers')
    .select('provider_customer_id')
    .eq('owner_id', userId)
    .maybeSingle()
  if (existing.error) return null
  if (existing.data?.provider_customer_id) return existing.data.provider_customer_id as string

  // The Moxscore user id travels as metadata for reconciliation only. Webhook
  // handling resolves ownership from billing_customers, never from metadata,
  // because metadata is writable from the Stripe dashboard.
  const customer = await stripe.customers.create(
    { email: email ?? undefined, metadata: { moxscore_user_id: userId } },
    { idempotencyKey: `customer:${userId}` },
  )

  const inserted = await db
    .from('billing_customers')
    .insert({ owner_id: userId, provider_customer_id: customer.id })
    .select('provider_customer_id')
    .maybeSingle()
  // A concurrent request may have won the insert; re-read rather than fail.
  if (inserted.error) {
    const retry = await db
      .from('billing_customers')
      .select('provider_customer_id')
      .eq('owner_id', userId)
      .maybeSingle()
    return (retry.data?.provider_customer_id as string | undefined) ?? null
  }
  return customer.id
}

/**
 * Reads the current period end from a subscription.
 *
 * Stripe moved `current_period_end` from the subscription to its items in the
 * 2025 API versions. Both shapes are checked so an API-version bump does not
 * silently start writing null period ends — which would expire live customers.
 */
export function periodEndFrom(subscription: Stripe.Subscription): string | null {
  const top = (subscription as unknown as { current_period_end?: number }).current_period_end
  const item = subscription.items?.data?.[0] as unknown as { current_period_end?: number } | undefined
  const seconds = typeof top === 'number' ? top : item?.current_period_end
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null
}

export function priceKeyFrom(subscription: Stripe.Subscription, env: ServerEnv = process.env): string {
  const priceId = subscription.items?.data?.[0]?.price?.id
  for (const key of PRICE_KEYS) {
    if (priceId && priceIdFor(key, env) === priceId) return key
  }
  // Unknown provider ids are deliberately collapsed. Reconciliation needs the
  // fact that a price is unknown, not the identifier itself, and operational
  // records must not accumulate raw provider ids.
  return 'unknown'
}
