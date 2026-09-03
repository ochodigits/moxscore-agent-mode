import type { TunerSwap } from './bracketTuner'
import type { AuthenticatedFetch } from './accountApi'

export const AI_TUNE_REQUEST_SCHEMA = 'moxscore.tune-explanations.request.v1'
export const AI_TUNE_RESPONSE_SCHEMA = 'moxscore.tune-explanations.response.v1'
export const AI_TUNE_PROMPT_VERSION = 'tune-explanations.2026-08-23.v1'

export interface AiExplanationResponse {
  requestId: string
  schemaVersion: typeof AI_TUNE_RESPONSE_SCHEMA
  promptVersion: typeof AI_TUNE_PROMPT_VERSION
  explanations: Array<{
    pairIndex: number
    cut: string
    add: string
    reasoning: string
    source: 'provider' | 'deterministic'
  }>
  providerOutcome: 'success' | 'partial_fallback' | 'invalid_output' | 'provider_error' | 'fallback'
  providerCalled: boolean
  replayed: boolean
  fallbackReason: string | null
  quota: { monthlyLimit: number; monthlyUsed: number | null; monthlyRemaining: number | null }
  budgetWarning: boolean
}

function validResponse(value: unknown, requestId: string, swaps: readonly TunerSwap[]): value is AiExplanationResponse {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Partial<AiExplanationResponse>
  if (
    body.requestId !== requestId
    || body.schemaVersion !== AI_TUNE_RESPONSE_SCHEMA
    || body.promptVersion !== AI_TUNE_PROMPT_VERSION
    || !['success', 'partial_fallback', 'invalid_output', 'provider_error', 'fallback'].includes(String(body.providerOutcome))
    || typeof body.providerCalled !== 'boolean'
    || typeof body.replayed !== 'boolean'
    || (body.fallbackReason !== null && typeof body.fallbackReason !== 'string')
    || typeof body.budgetWarning !== 'boolean'
    || typeof body.quota !== 'object'
    || body.quota === null
    || !Number.isInteger(body.quota.monthlyLimit)
    || (body.quota.monthlyUsed !== null && !Number.isInteger(body.quota.monthlyUsed))
    || (body.quota.monthlyRemaining !== null && !Number.isInteger(body.quota.monthlyRemaining))
    || !Array.isArray(body.explanations)
  ) return false
  if (body.explanations.length !== swaps.length) return false
  return body.explanations.every((item, index) => {
    const swap = swaps[index]
    return swap !== undefined
      && swap.cut !== null
      && swap.add !== null
      && item.pairIndex === index
      && item.cut === swap.cut
      && item.add === swap.add
      && typeof item.reasoning === 'string'
      && item.reasoning.length > 0
      && item.reasoning.length <= 280
      && (item.source === 'provider' || item.source === 'deterministic')
  })
}

export async function explainTunerSwaps(
  request: AuthenticatedFetch,
  requestId: string,
  swaps: readonly TunerSwap[],
  targetBracket: 2 | 3 | 4 | 5,
): Promise<AiExplanationResponse> {
  // Add-only and cut-only moves lack a cut/add pair for the provider to narrate.
  const explainable = swaps
    .filter((swap): swap is TunerSwap & { cut: string; add: string } => swap.cut !== null && swap.add !== null)
    .slice(0, 10)
  if (explainable.length === 0) {
    throw new Error('No cut/add pairs to explain — add-only and cut-only moves stay local.')
  }
  const response = await request('/api/tune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: AI_TUNE_REQUEST_SCHEMA,
      requestId,
      pairs: explainable.map((swap) => ({
        cut: swap.cut,
        add: swap.add,
        facts: { role: swap.role, cutReason: swap.cutReason, targetBracket },
      })),
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((body as { error?: string }).error ?? 'AI explanations are unavailable.')
  if (!validResponse(body, requestId, explainable)) throw new Error('AI explanation response was invalid.')
  return body
}

export async function submitAiExplanationFeedback(
  request: AuthenticatedFetch,
  requestId: string,
  rating: 'up' | 'down',
  reasonCode: 'helpful' | 'irrelevant' | 'unclear' | 'unsupported' | 'too_generic',
): Promise<void> {
  const response = await request('/api/ai-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, rating, reasonCode }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Feedback is unavailable.')
  }
}
