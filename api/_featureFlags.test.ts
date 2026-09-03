import { describe, expect, it } from 'vitest'
import { coreOperatingReadinessApproved, operatingReadinessApproved, serverFeatureEnabled } from './_featureFlags'

const production = { VERCEL_ENV: 'production' }
const preview = { VERCEL_ENV: 'preview' }

describe('v2 server feature flags', () => {
  it('keeps every feature closed unless its exact server-side flag is enabled', () => {
    expect(serverFeatureEnabled('accounts', production)).toBe(false)
    expect(serverFeatureEnabled('billing', production)).toBe(false)
    expect(serverFeatureEnabled('discordPod', preview)).toBe(false)
  })

  it('allows preview validation without treating it as a production release', () => {
    expect(serverFeatureEnabled('accounts', { ...preview, MOXSCORE_ENABLE_ACCOUNTS: 'true' })).toBe(true)
    expect(serverFeatureEnabled('billing', { ...preview, MOXSCORE_ENABLE_BILLING: 'true' })).toBe(true)
  })

  it('requires the explicit C1 operating-readiness approval for paid production features', () => {
    const billingEnabled = { ...production, MOXSCORE_ENABLE_BILLING: 'true' }
    expect(serverFeatureEnabled('billing', billingEnabled)).toBe(false)
    expect(serverFeatureEnabled('proAi', { ...billingEnabled, MOXSCORE_ENABLE_PRO_AI: 'true' })).toBe(false)
    expect(serverFeatureEnabled('collections', { ...production, MOXSCORE_ENABLE_COLLECTIONS: 'true' })).toBe(false)
    expect(operatingReadinessApproved({ ...billingEnabled, MOXSCORE_C1_OPERATING_READINESS: 'approved' })).toBe(true)
    expect(serverFeatureEnabled('billing', { ...billingEnabled, MOXSCORE_C1_OPERATING_READINESS: 'approved' })).toBe(true)
  })

  it('uses the separate Core readiness gate for free account persistence', () => {
    const core = { ...production, MOXSCORE_ENABLE_ACCOUNTS: 'true', MOXSCORE_ENABLE_PERSISTENCE: 'true', MOXSCORE_ENABLE_COLLECTIONS: 'true' }
    expect(serverFeatureEnabled('accounts', core)).toBe(false)
    expect(serverFeatureEnabled('persistence', core)).toBe(false)
    expect(coreOperatingReadinessApproved({ ...core, MOXSCORE_CORE_OPERATING_READINESS: 'approved' })).toBe(true)
    expect(serverFeatureEnabled('accounts', { ...core, MOXSCORE_CORE_OPERATING_READINESS: 'approved' })).toBe(true)
    expect(serverFeatureEnabled('persistence', { ...core, MOXSCORE_CORE_OPERATING_READINESS: 'approved' })).toBe(true)
    expect(serverFeatureEnabled('collections', { ...core, MOXSCORE_CORE_OPERATING_READINESS: 'approved' })).toBe(true)
  })

  it('keeps Discord identity production-closed without C1', () => {
    expect(serverFeatureEnabled('discordLink', { ...production, MOXSCORE_ENABLE_DISCORD_LINK: 'true' })).toBe(false)
  })

  it('keeps every deferred paid, provider, Pod, and Discord feature closed when flags are forged', () => {
    const forged = {
      ...production,
      MOXSCORE_ENABLE_BILLING: 'true',
      MOXSCORE_ENABLE_PRO_AI: 'true',
      MOXSCORE_ENABLE_ADVANCED_POD: 'true',
      MOXSCORE_ENABLE_DISCORD_LINK: 'true',
      MOXSCORE_ENABLE_DISCORD_POD: 'true',
    }
    expect(serverFeatureEnabled('billing', forged)).toBe(false)
    expect(serverFeatureEnabled('proAi', forged)).toBe(false)
    expect(serverFeatureEnabled('advancedPod', forged)).toBe(false)
    expect(serverFeatureEnabled('discordLink', forged)).toBe(false)
    expect(serverFeatureEnabled('discordPod', forged)).toBe(false)
  })
})
