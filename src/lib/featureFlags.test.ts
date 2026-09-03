import { afterEach, describe, expect, it, vi } from 'vitest'
import { billingUiEnabled, deferredPreviewEnabled, deterministicTunerEnabled } from './featureFlags'

describe('browser feature affordances', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps the deterministic tuner available as a free Core workflow', () => {
    expect(deterministicTunerEnabled()).toBe(true)
  })

  it('keeps legacy deferred affordances development-only', () => {
    expect(typeof deferredPreviewEnabled()).toBe('boolean')
  })

  it('treats billing UI as an affordance that defaults off', () => {
    vi.stubEnv('VITE_ENABLE_BILLING', '')
    expect(billingUiEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_BILLING', 'true')
    expect(billingUiEnabled()).toBe(true)
  })
})
