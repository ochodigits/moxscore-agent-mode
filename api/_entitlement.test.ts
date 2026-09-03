import { describe, expect, it } from 'vitest'
import {
  capabilitiesFor,
  entitlementFrom,
  freeEntitlement,
  limitsFor,
  planFor,
  requireCapability,
  resolveEntitlement,
  subscriptionGrantsPro,
  type SubscriptionRow,
} from './_entitlement'

const NOW = Date.parse('2026-08-15T12:00:00Z')
const FUTURE = '2026-09-15T12:00:00Z'
const PAST = '2026-07-15T12:00:00Z'

const preview = { VERCEL_ENV: 'preview' }
const production = { VERCEL_ENV: 'production' }

/** Every flag a Pro capability needs, in an environment that is not Production. */
const previewProFlags = {
  ...preview,
  MOXSCORE_ENABLE_ACCOUNTS: 'true',
  MOXSCORE_ENABLE_PERSISTENCE: 'true',
  MOXSCORE_ENABLE_COLLECTIONS: 'true',
  MOXSCORE_ENABLE_BILLING: 'true',
  MOXSCORE_ENABLE_PRO_AI: 'true',
  MOXSCORE_ENABLE_ADVANCED_POD: 'true',
  MOXSCORE_ENABLE_DISCORD_POD: 'true',
}

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    status: 'active',
    price_key: 'pro_monthly',
    current_period_end: FUTURE,
    cancel_at_period_end: false,
    reconciliation_blocked: false,
    ...overrides,
  }
}

describe('subscription state rules', () => {
  it('grants on active and trialing within the paid period', () => {
    expect(subscriptionGrantsPro(row({ status: 'active' }), NOW, preview)).toBe(true)
    expect(subscriptionGrantsPro(row({ status: 'trialing' }), NOW, preview)).toBe(true)
  })

  it('never grants Pro for a subscription on an unrelated Stripe price', () => {
    expect(subscriptionGrantsPro(row({ price_key: 'price_external_product' }), NOW, preview)).toBe(false)
    expect(subscriptionGrantsPro(row({ price_key: 'pro_annual' }), NOW, preview)).toBe(true)
  })

  it('fails closed while reconciliation marks ownership or state ambiguous', () => {
    expect(subscriptionGrantsPro(row({ reconciliation_blocked: true }), NOW, preview)).toBe(false)
  })

  it('refuses every non-granting provider status', () => {
    for (const status of ['unpaid', 'incomplete', 'incomplete_expired', 'paused'] as const) {
      expect(subscriptionGrantsPro(row({ status }), NOW, preview)).toBe(false)
    }
  })

  it('honours cancel-at-period-end until the period actually ends', () => {
    expect(subscriptionGrantsPro(row({ status: 'canceled', current_period_end: FUTURE }), NOW, preview)).toBe(true)
    expect(subscriptionGrantsPro(row({ status: 'canceled', current_period_end: PAST }), NOW, preview)).toBe(false)
    expect(subscriptionGrantsPro(row({ status: 'canceled', current_period_end: null }), NOW, preview)).toBe(false)
  })

  it('expires an active subscription whose period end has elapsed', () => {
    // A stalled webhook must not extend access indefinitely.
    expect(subscriptionGrantsPro(row({ status: 'active', current_period_end: PAST }), NOW, preview)).toBe(false)
  })

  it('treats past_due as closed unless a grace period is explicitly configured', () => {
    expect(subscriptionGrantsPro(row({ status: 'past_due' }), NOW, preview)).toBe(false)
    expect(
      subscriptionGrantsPro(row({ status: 'past_due' }), NOW, { ...preview, MOXSCORE_BILLING_GRACE_PAST_DUE: 'true' }),
    ).toBe(true)
    // Grace never resurrects an already-elapsed period.
    expect(
      subscriptionGrantsPro(row({ status: 'past_due', current_period_end: PAST }), NOW, {
        ...preview,
        MOXSCORE_BILLING_GRACE_PAST_DUE: 'true',
      }),
    ).toBe(false)
  })

  it('takes the strongest plan across multiple rows', () => {
    expect(planFor([row({ status: 'canceled', current_period_end: PAST }), row()], NOW, preview)).toBe('pro')
    expect(planFor([row({ status: 'unpaid' })], NOW, preview)).toBe('free')
    expect(planFor([], NOW, preview)).toBe('free')
  })
})

describe('capability mapping', () => {
  it('gives free accounts the Core persistence capabilities only', () => {
    const caps = capabilitiesFor('free', {
      ...preview,
      MOXSCORE_ENABLE_PERSISTENCE: 'true',
      MOXSCORE_ENABLE_COLLECTIONS: 'true',
    })
    expect(caps.saved_decks).toBe(true)
    expect(caps.deck_versions).toBe(true)
    expect(caps.collection_persistence).toBe(true)
    expect(caps.advanced_tuner).toBe(false)
    expect(caps.ai_explanations).toBe(false)
    expect(caps.discord_pod_check).toBe(false)
  })

  it('gives Pro every capability when the flags are open', () => {
    const caps = capabilitiesFor('pro', previewProFlags)
    expect(Object.values(caps).every(Boolean)).toBe(true)
  })

  it('lets a closed feature flag beat a paid plan', () => {
    // Subscription says Pro; the AI flag is off. The capability stays closed.
    const caps = capabilitiesFor('pro', { ...previewProFlags, MOXSCORE_ENABLE_PRO_AI: 'false' })
    expect(caps.ai_explanations).toBe(false)
    expect(caps.advanced_tuner).toBe(false)
    expect(caps.advanced_pod).toBe(true)
  })

  it('keeps every paid capability closed in Production without C1 approval', () => {
    const caps = capabilitiesFor('pro', {
      ...previewProFlags,
      ...production,
      MOXSCORE_CORE_OPERATING_READINESS: 'approved',
    })
    expect(caps.ai_explanations).toBe(false)
    expect(caps.advanced_pod).toBe(false)
    expect(caps.discord_pod_check).toBe(false)
    // Core capabilities remain available on their own gate.
    expect(caps.saved_decks).toBe(true)
  })

  it('raises the saved-deck ceiling only for Pro', () => {
    expect(limitsFor('free').savedDecks).toBe(10)
    expect(limitsFor('pro').savedDecks).toBe(100)
    expect(limitsFor('free').aiSessionsPerMonth).toBe(0)
    expect(limitsFor('pro').aiSessionsPerMonth).toBe(50)
  })
})

describe('entitlement envelope', () => {
  it('reports the granting period and cancellation intent', () => {
    const entitlement = entitlementFrom([row({ cancel_at_period_end: true })], NOW, previewProFlags)
    expect(entitlement.plan).toBe('pro')
    expect(entitlement.periodEnd).toBe(FUTURE)
    expect(entitlement.cancelAtPeriodEnd).toBe(true)
  })

  it('exposes no period for a free account', () => {
    const entitlement = freeEntitlement(preview)
    expect(entitlement.plan).toBe('free')
    expect(entitlement.periodEnd).toBeNull()
    expect(entitlement.cancelAtPeriodEnd).toBe(false)
  })
})

describe('resolveEntitlement', () => {
  function dbReturning(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('never queries the database when billing is off', async () => {
    const db = {
      from: () => {
        throw new Error('the free product must not depend on billing storage')
      },
    } as never
    const result = await resolveEntitlement(db, 'user-1', NOW, preview)
    expect(result.kind).toBe('ready')
    expect(result.kind === 'ready' && result.entitlement.plan).toBe('free')
  })

  it('resolves Pro from a granting subscription row', async () => {
    const result = await resolveEntitlement(dbReturning({ data: [row()], error: null }), 'user-1', NOW, previewProFlags)
    expect(result.kind === 'ready' && result.entitlement.plan).toBe('pro')
  })

  it('reports unavailable rather than downgrading on a query error', async () => {
    const result = await resolveEntitlement(
      dbReturning({ data: null, error: { message: 'outage' } }),
      'user-1',
      NOW,
      previewProFlags,
    )
    expect(result.kind).toBe('unavailable')
  })
})

describe('requireCapability', () => {
  it('allows a granted capability', () => {
    const result = requireCapability({ kind: 'ready', entitlement: entitlementFrom([row()], NOW, previewProFlags) }, 'ai_explanations')
    expect(result.ok).toBe(true)
  })

  it('returns 403 for a known user without the capability', () => {
    const result = requireCapability({ kind: 'ready', entitlement: freeEntitlement(preview) }, 'ai_explanations')
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('returns 503 when entitlement storage is unavailable', () => {
    const result = requireCapability({ kind: 'unavailable' }, 'ai_explanations')
    expect(result).toMatchObject({ ok: false, status: 503 })
  })
})
