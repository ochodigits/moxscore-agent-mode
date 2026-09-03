type ServerEnv = Record<string, string | undefined>

export type ServerFeature =
  | 'accounts'
  | 'persistence'
  | 'billing'
  | 'proAi'
  | 'advancedPod'
  | 'discordLink'
  | 'discordPod'
  | 'collections'

const FEATURE_ENV: Record<ServerFeature, string> = {
  accounts: 'MOXSCORE_ENABLE_ACCOUNTS',
  persistence: 'MOXSCORE_ENABLE_PERSISTENCE',
  billing: 'MOXSCORE_ENABLE_BILLING',
  proAi: 'MOXSCORE_ENABLE_PRO_AI',
  advancedPod: 'MOXSCORE_ENABLE_ADVANCED_POD',
  discordLink: 'MOXSCORE_ENABLE_DISCORD_LINK',
  discordPod: 'MOXSCORE_ENABLE_DISCORD_POD',
  collections: 'MOXSCORE_ENABLE_COLLECTIONS',
}

const C1_GATED_FEATURES = new Set<ServerFeature>([
  'billing', 'proAi', 'advancedPod', 'discordLink', 'discordPod',
])

// Accounts, saved decks, and collections are free v2 Core capabilities. They
// have a separate operating-readiness gate in Production; C1 is exclusively
// for the deferred paid/provider programme.
const CORE_GATED_FEATURES = new Set<ServerFeature>(['accounts', 'persistence', 'collections'])

function isProduction(env: ServerEnv): boolean {
  if (env.VERCEL_ENV !== undefined) return env.VERCEL_ENV === 'production'
  return env.NODE_ENV === 'production'
}

/** C1 is intentionally separate from C0's commercial-scope record. */
export function operatingReadinessApproved(env: ServerEnv = process.env): boolean {
  return env.MOXSCORE_C1_OPERATING_READINESS === 'approved'
}

export function coreOperatingReadinessApproved(env: ServerEnv = process.env): boolean {
  return env.MOXSCORE_CORE_OPERATING_READINESS === 'approved'
}

/**
 * The canonical server-side v2 flag check. Browser state is never an input.
 * Revenue-bearing features additionally need a deliberate C1 production
 * approval, even if an individual feature variable is accidentally enabled.
 */
export function serverFeatureEnabled(feature: ServerFeature, env: ServerEnv = process.env): boolean {
  if (env[FEATURE_ENV[feature]] !== 'true') return false
  if (!isProduction(env)) return true
  if (CORE_GATED_FEATURES.has(feature)) return coreOperatingReadinessApproved(env)
  return !C1_GATED_FEATURES.has(feature) || operatingReadinessApproved(env)
}

/** Legacy Preview-only API surfaces remain unavailable in Production. */
export function deferredAiEnabled(env: ServerEnv = process.env): boolean {
  return !isProduction(env) && env.MOXSCORE_ENABLE_DEFERRED_AI === 'true'
}

/** Legacy Preview-only API surfaces remain unavailable in Production. */
export function deferredPodEnabled(env: ServerEnv = process.env): boolean {
  return !isProduction(env) && env.MOXSCORE_ENABLE_DEFERRED_POD === 'true'
}
