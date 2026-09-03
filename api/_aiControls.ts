type ServerEnv = Record<string, string | undefined>

export interface AiCostControls {
  dailyBudgetMicros: number
  monthlyBudgetMicros: number
  concurrencyLimit: number
  reservationMicros: number
  inputCostPerMillionMicros: number
  outputCostPerMillionMicros: number
  maxInputTokens: number
  providerLeaseSeconds: number
}

function requiredInteger(raw: string | undefined, min: number, max: number): number | null {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

function optionalInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  return requiredInteger(raw, min, max) ?? fallback
}

export function estimateAiCostMicros(
  inputTokens: number,
  outputTokens: number,
  controls: Pick<AiCostControls, 'inputCostPerMillionMicros' | 'outputCostPerMillionMicros'>,
): number {
  const boundedTokens = (value: number): number => Number.isSafeInteger(value) && value > 0 ? value : 0
  const input = BigInt(boundedTokens(inputTokens)) * BigInt(controls.inputCostPerMillionMicros)
  const output = BigInt(boundedTokens(outputTokens)) * BigInt(controls.outputCostPerMillionMicros)
  const micros = (input + output + 999_999n) / 1_000_000n
  return Number(micros > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : micros)
}

/**
 * UTF-8 bytes are a provider-neutral upper bound on BPE-style token count:
 * every token consumes at least one byte. This deliberately over-reserves.
 */
export function conservativeAiInputTokens(system: string, user: string): number {
  return Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8')
}

/**
 * Budgets, price rates, and concurrency are owner-controlled configuration.
 * Missing any of them keeps provider work closed instead of inventing a spend
 * policy. Only mechanical token/lease bounds have conservative defaults.
 */
export function aiCostControls(env: ServerEnv = process.env): AiCostControls | null {
  const dailyBudgetMicros = requiredInteger(env.MOXSCORE_AI_DAILY_BUDGET_MICROS, 1, 1_000_000_000_000)
  const monthlyBudgetMicros = requiredInteger(env.MOXSCORE_AI_MONTHLY_BUDGET_MICROS, 1, 10_000_000_000_000)
  const concurrencyLimit = requiredInteger(env.MOXSCORE_AI_CONCURRENCY_LIMIT, 1, 20)
  const inputCostPerMillionMicros = requiredInteger(env.MOXSCORE_AI_INPUT_COST_PER_MILLION_MICROS, 1, 1_000_000_000_000)
  const outputCostPerMillionMicros = requiredInteger(env.MOXSCORE_AI_OUTPUT_COST_PER_MILLION_MICROS, 1, 1_000_000_000_000)
  if (
    dailyBudgetMicros === null
    || monthlyBudgetMicros === null
    || dailyBudgetMicros > monthlyBudgetMicros
    || concurrencyLimit === null
    || inputCostPerMillionMicros === null
    || outputCostPerMillionMicros === null
  ) return null
  const maxInputTokens = optionalInteger(env.MOXSCORE_AI_MAX_INPUT_TOKENS, 3_000, 500, 10_000)
  const maxOutputTokens = optionalInteger(env.MOXSCORE_AI_MAX_OUTPUT_TOKENS, 800, 128, 2_000)
  const base = { inputCostPerMillionMicros, outputCostPerMillionMicros }
  const reservationMicros = estimateAiCostMicros(maxInputTokens, maxOutputTokens, base)
  if (reservationMicros <= 0 || reservationMicros > dailyBudgetMicros || reservationMicros > monthlyBudgetMicros) return null
  return {
    dailyBudgetMicros,
    monthlyBudgetMicros,
    concurrencyLimit,
    reservationMicros,
    inputCostPerMillionMicros,
    outputCostPerMillionMicros,
    maxInputTokens,
    providerLeaseSeconds: optionalInteger(env.MOXSCORE_AI_PROVIDER_LEASE_SECONDS, 60, 30, 180),
  }
}

export interface AiCapacityDecision {
  allowed: boolean
  reason: 'granted' | 'replay' | 'daily_budget' | 'monthly_budget' | 'concurrency'
  daily_committed_micros: number
  monthly_committed_micros: number
  active_leases: number
}

export function aiBudgetWarning(decision: AiCapacityDecision, controls: AiCostControls): boolean {
  return decision.daily_committed_micros >= Math.ceil(controls.dailyBudgetMicros * 0.8)
    || decision.monthly_committed_micros >= Math.ceil(controls.monthlyBudgetMicros * 0.8)
}

export function budgetPercentage(committed: number, limit: number): number {
  if (limit <= 0) return 100
  return Math.min(100, Math.max(0, Math.round((committed / limit) * 10_000) / 100))
}
