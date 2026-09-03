import { serverFeatureEnabled } from './_featureFlags.js'

type ServerEnv = Record<string, string | undefined>

export type BillingOperation = 'checkout' | 'webhookProjection' | 'reconciliation' | 'repair'

const BILLING_OPERATION_ENV: Record<BillingOperation, string> = {
  checkout: 'MOXSCORE_ENABLE_CHECKOUT',
  webhookProjection: 'MOXSCORE_ENABLE_WEBHOOK_PROJECTION',
  reconciliation: 'MOXSCORE_ENABLE_BILLING_RECONCILIATION',
  repair: 'MOXSCORE_ENABLE_BILLING_REPAIR',
}

/**
 * Independent commercial controls beneath the global billing master switch.
 * Closing Checkout must not close Portal or safe processing of existing paid
 * subscriptions. Production C1 remains enforced by serverFeatureEnabled.
 */
export function billingOperationEnabled(
  operation: BillingOperation,
  env: ServerEnv = process.env,
): boolean {
  return serverFeatureEnabled('billing', env) && env[BILLING_OPERATION_ENV[operation]] === 'true'
}

/** Provider work has a separate emergency switch from the Pro AI capability. */
export function aiProviderCallsEnabled(env: ServerEnv = process.env): boolean {
  return serverFeatureEnabled('proAi', env) && env.MOXSCORE_ENABLE_AI_PROVIDER_CALLS === 'true'
}
