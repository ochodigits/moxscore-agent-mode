/**
 * UI-only Preview affordance. It is not an entitlement and must never be used
 * to authorize an API request or reveal paid data.
 */
export function deferredPreviewEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEFERRED_FEATURES === 'true'
}

/** The deterministic tuner is a free Core workflow, never an entitlement. */
export function deterministicTunerEnabled(): boolean {
  return true
}

/**
 * UI affordance for pricing/checkout chrome only. Server billing still requires
 * MOXSCORE_ENABLE_BILLING (+ C1 in Production). This flag must never authorize
 * a paid capability or reveal subscription rows.
 */
export function billingUiEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_BILLING === 'true'
}
