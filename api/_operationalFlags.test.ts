import { describe, expect, it } from 'vitest'
import { aiProviderCallsEnabled, billingOperationEnabled } from './_operationalFlags'

const preview = { VERCEL_ENV: 'preview', MOXSCORE_ENABLE_BILLING: 'true' }

describe('independent operational controls', () => {
  it('keeps every billing operation closed by default under an open master flag', () => {
    expect(billingOperationEnabled('checkout', preview)).toBe(false)
    expect(billingOperationEnabled('webhookProjection', preview)).toBe(false)
    expect(billingOperationEnabled('reconciliation', preview)).toBe(false)
    expect(billingOperationEnabled('repair', preview)).toBe(false)
  })

  it('opens only the named billing operation', () => {
    const env = { ...preview, MOXSCORE_ENABLE_WEBHOOK_PROJECTION: 'true' }
    expect(billingOperationEnabled('webhookProjection', env)).toBe(true)
    expect(billingOperationEnabled('checkout', env)).toBe(false)
    expect(billingOperationEnabled('repair', env)).toBe(false)
  })

  it('lets the billing master and Production C1 gate beat child switches', () => {
    const childFlags = {
      MOXSCORE_ENABLE_CHECKOUT: 'true',
      MOXSCORE_ENABLE_WEBHOOK_PROJECTION: 'true',
      MOXSCORE_ENABLE_BILLING_RECONCILIATION: 'true',
      MOXSCORE_ENABLE_BILLING_REPAIR: 'true',
    }
    expect(billingOperationEnabled('checkout', { ...childFlags, VERCEL_ENV: 'preview' })).toBe(false)
    expect(billingOperationEnabled('repair', {
      ...childFlags,
      VERCEL_ENV: 'production',
      MOXSCORE_ENABLE_BILLING: 'true',
    })).toBe(false)
  })

  it('requires a separate provider-call switch beneath the Pro AI flag', () => {
    expect(aiProviderCallsEnabled({ VERCEL_ENV: 'preview', MOXSCORE_ENABLE_PRO_AI: 'true' })).toBe(false)
    expect(aiProviderCallsEnabled({
      VERCEL_ENV: 'preview',
      MOXSCORE_ENABLE_PRO_AI: 'true',
      MOXSCORE_ENABLE_AI_PROVIDER_CALLS: 'true',
    })).toBe(true)
  })
})
