// Capability-based entitlement resolution.
//
// The rest of the API asks "does this user have `ai_explanations`?" — never
// "is this user Pro?". Named capabilities keep a pricing change from touching
// code paths, and keep a plan rename from silently widening access.
//
// Three inputs decide a capability, all server-side:
//   1. the server feature flag (+ C1 / Core operating readiness in Production)
//   2. the projected subscription state for this user
//   3. the static free-vs-Pro capability map below
//
// Browser state is never an input. A forged `?pro=1`, local-storage entry,
// user id, or price id reaches none of this.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isPriceKey } from './_billing.js'
import { serverFeatureEnabled } from './_featureFlags.js'

type ServerEnv = Record<string, string | undefined>

export type Capability =
  | 'saved_decks'
  | 'deck_versions'
  | 'collection_persistence'
  | 'advanced_tuner'
  | 'ai_explanations'
  | 'advanced_pod'
  | 'discord_pod_check'

export const CAPABILITIES: readonly Capability[] = [
  'saved_decks',
  'deck_versions',
  'collection_persistence',
  'advanced_tuner',
  'ai_explanations',
  'advanced_pod',
  'discord_pod_check',
]

export type Plan = 'free' | 'pro'

/** Provider subscription vocabulary, mirrored from the migration's check constraint. */
export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'
  | 'canceled'

export interface SubscriptionRow {
  status: SubscriptionStatus
  price_key: string
  current_period_end: string | null
  cancel_at_period_end: boolean
  /** Reconciliation ambiguity blocks every paid grant until a clean re-read. */
  reconciliation_blocked: boolean
}

export interface EntitlementLimits {
  savedDecks: number
  versionsPerDeck: number
  collectionCards: number
  /** Pro AI tuning sessions per billing month. 0 when the capability is absent. */
  aiSessionsPerMonth: number
}

export interface Entitlement {
  plan: Plan
  capabilities: Record<Capability, boolean>
  limits: EntitlementLimits
  /** Present only for a Pro-granting subscription; omitted for free accounts. */
  periodEnd: string | null
  cancelAtPeriodEnd: boolean
}

export type EntitlementResult =
  | { kind: 'ready'; entitlement: Entitlement }
  /** Entitlement storage is unreachable. Callers must fail closed. */
  | { kind: 'unavailable' }

// ---------------------------------------------------------------------------
// Static plan maps
// ---------------------------------------------------------------------------

// Free capabilities are v2 Core: optional accounts may save decks, versions,
// and one collection without ever paying. They are gated by Core operating
// readiness, not by a subscription.
const FREE_CAPABILITIES: readonly Capability[] = [
  'saved_decks',
  'deck_versions',
  'collection_persistence',
]

// Pro adds the C1-gated capabilities on top of everything free.
const PRO_CAPABILITIES: readonly Capability[] = [
  ...FREE_CAPABILITIES,
  'advanced_tuner',
  'ai_explanations',
  'advanced_pod',
  'discord_pod_check',
]

// Each capability also requires its own server feature flag. This is what
// makes an accidental subscription row unable to open a closed feature.
const CAPABILITY_FEATURE: Record<Capability, Parameters<typeof serverFeatureEnabled>[0]> = {
  saved_decks: 'persistence',
  deck_versions: 'persistence',
  collection_persistence: 'collections',
  advanced_tuner: 'proAi',
  ai_explanations: 'proAi',
  advanced_pod: 'advancedPod',
  discord_pod_check: 'discordPod',
}

const FREE_LIMITS: EntitlementLimits = {
  savedDecks: 10,
  versionsPerDeck: 20,
  collectionCards: 10_000,
  aiSessionsPerMonth: 0,
}

const PRO_LIMITS: EntitlementLimits = {
  savedDecks: 100,
  versionsPerDeck: 20,
  collectionCards: 10_000,
  aiSessionsPerMonth: 50,
}

/** Burst controls, applied by the AI endpoint alongside the monthly allowance. */
export const AI_BURST_LIMITS = { perMinute: 5, perDay: 10 } as const

// ---------------------------------------------------------------------------
// Pure subscription rules
// ---------------------------------------------------------------------------

/**
 * Statuses that may grant paid capabilities. `past_due` is deliberately absent:
 * a grace period is an explicit business decision, enabled per-environment via
 * MOXSCORE_BILLING_GRACE_PAST_DUE rather than assumed here.
 */
const GRANTING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['active', 'trialing'])

function pastDueGraceEnabled(env: ServerEnv): boolean {
  return env.MOXSCORE_BILLING_GRACE_PAST_DUE === 'true'
}

/**
 * Whether one subscription row currently grants Pro.
 *
 * A `canceled` subscription still grants until its recorded period end — that
 * is what the customer paid for. Every other terminal status fails closed
 * immediately, and a granting status with an elapsed period end also fails:
 * a stalled webhook must never extend access indefinitely.
 */
export function subscriptionGrantsPro(
  row: SubscriptionRow,
  nowMs: number,
  env: ServerEnv = process.env,
): boolean {
  if (row.reconciliation_blocked) return false

  // The Stripe account may serve more than one product. A subscription owned
  // by this customer grants Moxscore Pro only when its price resolved to one
  // of our server allowlisted price keys. Unknown/raw provider price ids stay
  // recorded for reconciliation but fail closed here.
  if (!isPriceKey(row.price_key)) return false

  const periodEndMs = row.current_period_end === null ? null : Date.parse(row.current_period_end)
  const periodValid = periodEndMs !== null && Number.isFinite(periodEndMs) && periodEndMs > nowMs

  if (row.status === 'canceled') return periodValid
  if (row.status === 'past_due') return pastDueGraceEnabled(env) && periodValid
  if (!GRANTING_STATUSES.has(row.status)) return false

  // active / trialing: a missing period end is treated as current, since the
  // provider always supplies one for a live subscription.
  return periodEndMs === null ? true : periodValid
}

/** The strongest plan granted by any of a user's subscription rows. */
export function planFor(rows: readonly SubscriptionRow[], nowMs: number, env: ServerEnv = process.env): Plan {
  return rows.some((row) => subscriptionGrantsPro(row, nowMs, env)) ? 'pro' : 'free'
}

/**
 * Capability map for a plan. Every capability is the AND of its plan grant and
 * its server feature flag, so a closed flag beats a paid subscription.
 */
export function capabilitiesFor(plan: Plan, env: ServerEnv = process.env): Record<Capability, boolean> {
  const granted = new Set(plan === 'pro' ? PRO_CAPABILITIES : FREE_CAPABILITIES)
  const result = {} as Record<Capability, boolean>
  for (const capability of CAPABILITIES) {
    result[capability] = granted.has(capability) && serverFeatureEnabled(CAPABILITY_FEATURE[capability], env)
  }
  return result
}

export function limitsFor(plan: Plan): EntitlementLimits {
  return plan === 'pro' ? { ...PRO_LIMITS } : { ...FREE_LIMITS }
}

/** Builds the full entitlement envelope from already-fetched subscription rows. */
export function entitlementFrom(
  rows: readonly SubscriptionRow[],
  nowMs: number,
  env: ServerEnv = process.env,
): Entitlement {
  const plan = planFor(rows, nowMs, env)
  const granting = rows.find((row) => subscriptionGrantsPro(row, nowMs, env))
  return {
    plan,
    capabilities: capabilitiesFor(plan, env),
    limits: limitsFor(plan),
    periodEnd: granting?.current_period_end ?? null,
    cancelAtPeriodEnd: granting?.cancel_at_period_end ?? false,
  }
}

/** The free-account entitlement, used when billing is switched off entirely. */
export function freeEntitlement(env: ServerEnv = process.env): Entitlement {
  return {
    plan: 'free',
    capabilities: capabilitiesFor('free', env),
    limits: limitsFor('free'),
    periodEnd: null,
    cancelAtPeriodEnd: false,
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the current entitlement for one user.
 *
 * When billing is off, this short-circuits to the free entitlement without
 * touching the database — the free product must not depend on the commercial
 * control plane being reachable. When billing is on but the query fails, the
 * result is `unavailable` so callers can fail closed rather than silently
 * downgrading a paying customer to free.
 */
export async function resolveEntitlement(
  db: SupabaseClient,
  userId: string,
  nowMs = Date.now(),
  env: ServerEnv = process.env,
): Promise<EntitlementResult> {
  if (!serverFeatureEnabled('billing', env)) {
    return { kind: 'ready', entitlement: freeEntitlement(env) }
  }

  try {
    const { data, error } = await db
      .from('subscriptions')
      .select('status, price_key, current_period_end, cancel_at_period_end, reconciliation_blocked')
      .eq('owner_id', userId)
    if (error) return { kind: 'unavailable' }
    return { kind: 'ready', entitlement: entitlementFrom((data ?? []) as SubscriptionRow[], nowMs, env) }
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * Endpoint guard. `403` for a known user without the capability, `503` when
 * entitlement storage is unavailable — never a silent downgrade to free.
 */
export function requireCapability(
  result: EntitlementResult,
  capability: Capability,
): { ok: true; entitlement: Entitlement } | { ok: false; status: number; error: string } {
  if (result.kind === 'unavailable') {
    return { ok: false, status: 503, error: 'Entitlement service is temporarily unavailable.' }
  }
  if (!result.entitlement.capabilities[capability]) {
    return { ok: false, status: 403, error: 'This feature is not available on your plan.' }
  }
  return { ok: true, entitlement: result.entitlement }
}
