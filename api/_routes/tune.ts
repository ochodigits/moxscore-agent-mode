import type { SupabaseClient } from '@supabase/supabase-js'
import { accountAccess, accountError } from '../_account.js'
import { complete, aiProviderConfiguration } from '../_ai.js'
import {
  AI_TUNE_PROMPT_VERSION,
  AI_TUNE_REQUEST_SCHEMA,
  AI_TUNE_RESPONSE_SCHEMA,
  aiTuneInputHash,
  aiTunePrompts,
  deterministicExplanationSet,
  filterProviderExplanation,
  parseAiTuneRequest,
  parseCachedExplanationSet,
  type AiExplanationSet,
  type AiTuneRequest,
} from '../_aiContract.js'
import {
  aiBudgetWarning,
  aiCostControls,
  budgetPercentage,
  conservativeAiInputTokens,
  estimateAiCostMicros,
  type AiCapacityDecision,
} from '../_aiControls.js'
import { AI_BURST_LIMITS, requireCapability, resolveEntitlement } from '../_entitlement.js'
import { aiProviderCallsEnabled } from '../_operationalFlags.js'
import { currentRequestId } from '../_requestContext.js'

interface VercelReq {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}
interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

interface ClaimDecision {
  decision: 'acquired' | 'completed' | 'in_progress' | 'ambiguous_provider'
    | 'monthly_limit' | 'daily_limit' | 'burst_limit' | 'request_conflict'
  month_used: number
  day_used: number
  cached_response: unknown
}

type FallbackReason = 'switch_off' | 'configuration_closed' | 'quota_exhausted'
  | 'budget_exhausted' | 'concurrency_busy' | 'request_in_progress'
  | 'provider_error' | 'invalid_output' | 'input_too_large' | 'control_unavailable' | null

function rpcRow<T>(data: unknown): T | null {
  const value = Array.isArray(data) ? data[0] : data
  return typeof value === 'object' && value !== null ? value as T : null
}

function quotaEnvelope(limit: number, used: number | null): { monthlyLimit: number; monthlyUsed: number | null; monthlyRemaining: number | null } {
  return {
    monthlyLimit: limit,
    monthlyUsed: used,
    monthlyRemaining: used === null ? null : Math.max(0, limit - used),
  }
}

function cachedFallbackReason(outcome: AiExplanationSet['providerOutcome']): FallbackReason {
  if (outcome === 'success') return null
  if (outcome === 'provider_error') return 'provider_error'
  return 'invalid_output'
}

function responseBody(
  request: AiTuneRequest,
  explanations: AiExplanationSet,
  input: {
    providerCalled: boolean
    replayed?: boolean
    fallbackReason: FallbackReason
    monthlyLimit: number
    monthlyUsed: number | null
    budgetWarning?: boolean
  },
): Record<string, unknown> {
  return {
    requestId: request.requestId,
    ...explanations,
    providerCalled: input.providerCalled,
    replayed: input.replayed ?? false,
    fallbackReason: input.fallbackReason,
    quota: quotaEnvelope(input.monthlyLimit, input.monthlyUsed),
    budgetWarning: input.budgetWarning ?? false,
    versions: {
      requestSchema: AI_TUNE_REQUEST_SCHEMA,
      responseSchema: AI_TUNE_RESPONSE_SCHEMA,
      prompt: AI_TUNE_PROMPT_VERSION,
    },
  }
}

async function recordMetric(
  db: SupabaseClient,
  outcome: string,
  providerCalled: boolean,
  latencyMs = 0,
  inputTokens = 0,
  outputTokens = 0,
  costMicros = 0,
): Promise<void> {
  try {
    await db.rpc('moxscore_record_ai_metric', {
      p_outcome: outcome,
      p_provider_called: providerCalled,
      p_latency_ms: Math.min(120_000, Math.max(0, latencyMs)),
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_cost_micros: costMicros,
    })
  } catch {
    // Metrics never turn a deterministic fallback into a failed page.
  }
}

async function refundBeforeProvider(db: SupabaseClient, requestId: string): Promise<void> {
  try {
    await db.rpc('moxscore_refund_ai_quota', { p_request_id: requestId })
  } catch {
    // The provider marker is still false. A retry remains safe, and the
    // operations signal records the control-plane failure where possible.
  }
}

function fallback(
  res: VercelRes,
  request: AiTuneRequest,
  monthlyLimit: number,
  reason: Exclude<FallbackReason, null>,
  monthlyUsed: number | null,
  providerCalled = false,
): void {
  res.status(200).json(responseBody(request, deterministicExplanationSet(request), {
    providerCalled,
    fallbackReason: reason,
    monthlyLimit,
    monthlyUsed,
  }))
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const access = await accountAccess(req.headers, 'proAi')
  if (access.kind !== 'ready') {
    const { status, error } = accountError(access)
    res.status(status).json({ error })
    return
  }
  const capability = requireCapability(await resolveEntitlement(access.db, access.user.id), 'ai_explanations')
  if (!capability.ok) {
    res.status(capability.status).json({ error: capability.error })
    return
  }

  const request = parseAiTuneRequest(req.body)
  if (request === null) {
    res.status(400).json({ error: 'Invalid tune explanation request.' })
    return
  }
  const monthlyLimit = capability.entitlement.limits.aiSessionsPerMonth

  if (!aiProviderCallsEnabled()) {
    await recordMetric(access.db, 'switch_off', false)
    fallback(res, request, monthlyLimit, 'switch_off', null)
    return
  }

  const provider = aiProviderConfiguration()
  const controls = aiCostControls()
  if (provider === null || controls === null) {
    await recordMetric(access.db, 'config_closed', false)
    fallback(res, request, monthlyLimit, 'configuration_closed', null)
    return
  }
  const prompts = aiTunePrompts(request)
  if (conservativeAiInputTokens(prompts.system, prompts.user) > controls.maxInputTokens) {
    await recordMetric(access.db, 'input_too_large', false)
    fallback(res, request, monthlyLimit, 'input_too_large', null)
    return
  }

  const claimResult = await access.db.rpc('moxscore_claim_ai_explanation', {
    p_owner_id: access.user.id,
    p_request_id: request.requestId,
    p_input_hash: aiTuneInputHash(request),
    p_request_schema_version: AI_TUNE_REQUEST_SCHEMA,
    p_prompt_version: AI_TUNE_PROMPT_VERSION,
    p_monthly_limit: monthlyLimit,
    p_daily_limit: AI_BURST_LIMITS.perDay,
    p_minute_limit: AI_BURST_LIMITS.perMinute,
    p_lease_seconds: 90,
  })
  if (claimResult.error) {
    res.status(503).json({ error: 'AI controls are temporarily unavailable.' })
    return
  }
  const claim = rpcRow<ClaimDecision>(claimResult.data)
  if (claim === null) {
    res.status(503).json({ error: 'AI controls are temporarily unavailable.' })
    return
  }
  if (claim.decision === 'request_conflict') {
    res.status(409).json({ error: 'Request ID is already bound to different input.' })
    return
  }
  if (claim.decision === 'completed') {
    const cached = parseCachedExplanationSet(claim.cached_response, request)
    if (cached === null) {
      await recordMetric(access.db, 'control_unavailable', false)
      fallback(res, request, monthlyLimit, 'control_unavailable', claim.month_used)
      return
    }
    await recordMetric(access.db, 'replay', false)
    res.status(200).json(responseBody(request, cached, {
      providerCalled: false,
      replayed: true,
      fallbackReason: cachedFallbackReason(cached.providerOutcome),
      monthlyLimit,
      monthlyUsed: claim.month_used,
    }))
    return
  }
  if (claim.decision === 'in_progress' || claim.decision === 'ambiguous_provider') {
    await recordMetric(access.db, 'control_unavailable', false)
    fallback(res, request, monthlyLimit, 'request_in_progress', claim.month_used)
    return
  }
  if (claim.decision === 'monthly_limit' || claim.decision === 'daily_limit' || claim.decision === 'burst_limit') {
    await recordMetric(access.db, 'quota_denied', false)
    fallback(res, request, monthlyLimit, 'quota_exhausted', claim.month_used)
    return
  }
  if (claim.decision !== 'acquired') {
    res.status(503).json({ error: 'AI controls are temporarily unavailable.' })
    return
  }

  const capacityResult = await access.db.rpc('moxscore_reserve_ai_provider_capacity', {
    p_request_id: request.requestId,
    p_daily_budget_micros: controls.dailyBudgetMicros,
    p_monthly_budget_micros: controls.monthlyBudgetMicros,
    p_concurrency_limit: controls.concurrencyLimit,
    p_reservation_micros: controls.reservationMicros,
    p_lease_seconds: controls.providerLeaseSeconds,
  })
  const capacity = capacityResult.error ? null : rpcRow<AiCapacityDecision>(capacityResult.data)
  if (capacity === null) {
    await refundBeforeProvider(access.db, request.requestId)
    await recordMetric(access.db, 'control_unavailable', false)
    fallback(res, request, monthlyLimit, 'control_unavailable', Math.max(0, claim.month_used - 1))
    return
  }
  if (!capacity.allowed) {
    await refundBeforeProvider(access.db, request.requestId)
    const concurrency = capacity.reason === 'concurrency'
    await recordMetric(access.db, concurrency ? 'concurrency_denied' : 'budget_denied', false)
    fallback(
      res,
      request,
      monthlyLimit,
      concurrency ? 'concurrency_busy' : 'budget_exhausted',
      Math.max(0, claim.month_used - 1),
    )
    return
  }

  const warning = aiBudgetWarning(capacity, controls)
  if (warning) {
    console.warn('[ai-budget]', {
      request_id: currentRequestId() ?? 'unavailable',
      daily_percentage: budgetPercentage(capacity.daily_committed_micros, controls.dailyBudgetMicros),
      monthly_percentage: budgetPercentage(capacity.monthly_committed_micros, controls.monthlyBudgetMicros),
    })
  }

  const marked = await access.db.rpc('moxscore_mark_ai_provider_contacted', {
    p_request_id: request.requestId,
    p_provider: provider.provider,
    p_model: provider.model,
  })
  if (marked.error || marked.data !== true) {
    await refundBeforeProvider(access.db, request.requestId)
    await recordMetric(access.db, 'control_unavailable', false)
    fallback(res, request, monthlyLimit, 'control_unavailable', Math.max(0, claim.month_used - 1))
    return
  }

  const started = Date.now()
  let explanationSet: AiExplanationSet
  let inputTokens = 0
  let outputTokens = 0
  let costMicros = controls.reservationMicros
  try {
    const completed = await complete(prompts.system, prompts.user, provider)
    inputTokens = completed.inputTokens
    outputTokens = completed.outputTokens
    const measuredCost = estimateAiCostMicros(inputTokens, outputTokens, controls)
    costMicros = measuredCost > 0 ? measuredCost : controls.reservationMicros
    explanationSet = filterProviderExplanation(completed.text, request)
  } catch {
    explanationSet = deterministicExplanationSet(request, 'provider_error')
  }
  const latencyMs = Math.min(120_000, Math.max(0, Date.now() - started))

  const costResult = await access.db.rpc('moxscore_record_ai_cost', {
    p_request_id: request.requestId,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_estimated_cost_micros: costMicros,
  })
  if (costResult.error) {
    console.error('[ai-explanation]', { request_id: currentRequestId() ?? 'unavailable', outcome: 'cost_record_failed' })
    fallback(res, request, monthlyLimit, 'control_unavailable', claim.month_used, true)
    return
  }

  const completeResult = await access.db.rpc('moxscore_complete_ai_explanation', {
    p_request_id: request.requestId,
    p_response: explanationSet,
    p_outcome: explanationSet.providerOutcome,
    p_latency_ms: latencyMs,
  })
  if (completeResult.error) {
    console.error('[ai-explanation]', { request_id: currentRequestId() ?? 'unavailable', outcome: 'cache_record_failed' })
    fallback(res, request, monthlyLimit, 'control_unavailable', claim.month_used, true)
    return
  }

  const fallbackReason: FallbackReason = explanationSet.providerOutcome === 'success'
    ? null
    : explanationSet.providerOutcome === 'provider_error'
      ? 'provider_error'
      : 'invalid_output'
  res.status(200).json(responseBody(request, explanationSet, {
    providerCalled: true,
    fallbackReason,
    monthlyLimit,
    monthlyUsed: claim.month_used,
    budgetWarning: warning,
  }))
}
