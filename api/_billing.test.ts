import { describe, expect, it } from 'vitest'
import { isPriceKey, periodEndFrom, priceIdFor, priceKeyFrom, publicOrigin, stripeClient, webhookSecret } from './_billing'

const env = {
  STRIPE_PRICE_PRO_MONTHLY: 'price_live_monthly',
  STRIPE_PRICE_PRO_ANNUAL: 'price_live_annual',
}

describe('price allowlist', () => {
  it('accepts only the two published plan keys', () => {
    expect(isPriceKey('pro_monthly')).toBe(true)
    expect(isPriceKey('pro_annual')).toBe(true)
  })

  it('rejects anything a caller might substitute for a plan key', () => {
    // The browser must never be able to name a price, an amount, or a price
    // belonging to another Stripe account.
    expect(isPriceKey('price_live_monthly')).toBe(false)
    expect(isPriceKey('price_attacker_0')).toBe(false)
    expect(isPriceKey('')).toBe(false)
    expect(isPriceKey(null)).toBe(false)
    expect(isPriceKey({ toString: () => 'pro_monthly' })).toBe(false)
  })

  it('resolves keys to configured price ids and nothing else', () => {
    expect(priceIdFor('pro_monthly', env)).toBe('price_live_monthly')
    expect(priceIdFor('pro_annual', env)).toBe('price_live_annual')
    expect(priceIdFor('pro_monthly', {})).toBeNull()
    expect(priceIdFor('pro_monthly', { STRIPE_PRICE_PRO_MONTHLY: '   ' })).toBeNull()
  })
})

describe('configuration guards', () => {
  it('returns no client or secret when Stripe is unconfigured', () => {
    expect(stripeClient({})).toBeNull()
    expect(stripeClient({ STRIPE_SECRET_KEY: '  ' })).toBeNull()
    expect(webhookSecret({})).toBeNull()
  })

  it('normalises the public origin and never emits a trailing slash', () => {
    expect(publicOrigin({ PUBLIC_ORIGIN: 'https://moxscore.com/' })).toBe('https://moxscore.com')
    expect(publicOrigin({ PUBLIC_ORIGIN: 'https://preview.moxscore.com//' })).toBe('https://preview.moxscore.com')
    expect(publicOrigin({ PUBLIC_ORIGIN: 'http://127.0.0.1:5173/' })).toBe('http://127.0.0.1:5173')
  })

  it('fails closed when the billing return origin is missing or unsafe', () => {
    expect(publicOrigin({})).toBeNull()
    expect(publicOrigin({ PUBLIC_ORIGIN: 'http://preview.example.com' })).toBeNull()
    expect(publicOrigin({ PUBLIC_ORIGIN: 'https://example.com/path' })).toBeNull()
    expect(publicOrigin({ PUBLIC_ORIGIN: 'not a URL' })).toBeNull()
  })
})

describe('subscription field extraction', () => {
  const periodEnd = 1_789_000_000

  it('reads current_period_end from the subscription when present', () => {
    const sub = { current_period_end: periodEnd, items: { data: [] } } as never
    expect(periodEndFrom(sub)).toBe(new Date(periodEnd * 1000).toISOString())
  })

  it('falls back to the subscription item, where Stripe moved the field', () => {
    // Stripe's 2025 API versions relocated current_period_end onto items.
    // Missing this would write null period ends and expire live customers.
    const sub = { items: { data: [{ current_period_end: periodEnd }] } } as never
    expect(periodEndFrom(sub)).toBe(new Date(periodEnd * 1000).toISOString())
  })

  it('returns null when neither shape carries a usable value', () => {
    expect(periodEndFrom({ items: { data: [] } } as never)).toBeNull()
    expect(periodEndFrom({ items: { data: [{}] } } as never)).toBeNull()
    expect(periodEndFrom({} as never)).toBeNull()
  })

  it('maps a live price id back to its plan key', () => {
    const sub = { items: { data: [{ price: { id: 'price_live_annual' } }] } } as never
    expect(priceKeyFrom(sub, env)).toBe('pro_annual')
  })

  it('redacts an unrecognised price id rather than guessing a plan', () => {
    const sub = { items: { data: [{ price: { id: 'price_legacy_9' } }] } } as never
    expect(priceKeyFrom(sub, env)).toBe('unknown')
    expect(priceKeyFrom({ items: { data: [] } } as never, env)).toBe('unknown')
  })
})
