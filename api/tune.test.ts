import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AI_TUNE_PROVIDER_SCHEMA, AI_TUNE_REQUEST_SCHEMA, deterministicExplanationSet, parseAiTuneRequest } from './_aiContract'

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  requireCapability: vi.fn(),
  resolveEntitlement: vi.fn(),
  providerEnabled: vi.fn(),
  providerConfig: vi.fn(),
  controls: vi.fn(),
  complete: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('./_account.ts', () => ({
  accountAccess: (...args: unknown[]) => mocks.access(...args),
  accountError: (access: { kind: string }) => access.kind === 'disabled'
    ? { status: 404, error: 'Not available' }
    : access.kind === 'unauthenticated'
      ? { status: 401, error: 'Authentication required' }
      : { status: 503, error: 'Account service is temporarily unavailable.' },
}))
vi.mock('./_entitlement.ts', () => ({
  AI_BURST_LIMITS: { perMinute: 5, perDay: 10 },
  resolveEntitlement: (...args: unknown[]) => mocks.resolveEntitlement(...args),
  requireCapability: (...args: unknown[]) => mocks.requireCapability(...args),
}))
vi.mock('./_operationalFlags.ts', () => ({ aiProviderCallsEnabled: () => mocks.providerEnabled() }))
vi.mock('./_ai.ts', () => ({
  aiProviderConfiguration: () => mocks.providerConfig(),
  complete: (...args: unknown[]) => mocks.complete(...args),
}))
vi.mock('./_aiControls.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./_aiControls')>()
  return { ...original, aiCostControls: () => mocks.controls() }
})
vi.mock('./_requestContext.ts', () => ({ currentRequestId: () => 'server-request-id' }))

import handler from './_routes/tune'

const requestId = '123e4567-e89b-42d3-a456-426614174000'
const requestBody = {
  schemaVersion: AI_TUNE_REQUEST_SCHEMA,
  requestId,
  pairs: [{
    cut: 'Cancel',
    add: 'Arcane Denial',
    facts: { role: 'counterspell', cutReason: 'Lower mana efficiency.', targetBracket: 3 },
  }],
}
const entitlement = {
  plan: 'pro',
  capabilities: { ai_explanations: true },
  limits: { aiSessionsPerMonth: 50 },
  periodEnd: null,
  cancelAtPeriodEnd: false,
}
const controls = {
  dailyBudgetMicros: 100_000,
  monthlyBudgetMicros: 1_000_000,
  concurrencyLimit: 2,
  reservationMicros: 10_000,
  inputCostPerMillionMicros: 2_000_000,
  outputCostPerMillionMicros: 8_000_000,
  maxInputTokens: 3_000,
  providerLeaseSeconds: 60,
}

function createRes() {
  const result: { statusCode: number; body: Record<string, unknown> } = { statusCode: 200, body: {} }
  const res = {
    status(code: number) { result.statusCode = code; return res },
    json(body: unknown) { result.body = body as Record<string, unknown> },
  }
  return { res, result }
}

async function invoke(body: unknown = requestBody) {
  const { res, result } = createRes()
  await handler({ method: 'POST', body, headers: { authorization: 'Bearer token' } }, res)
  return result
}

function rpcSuccess(name: string) {
  if (name === 'moxscore_claim_ai_explanation') return { data: [{ decision: 'acquired', month_used: 1, day_used: 1, cached_response: null }], error: null }
  if (name === 'moxscore_reserve_ai_provider_capacity') return { data: [{ allowed: true, reason: 'granted', daily_committed_micros: 10_000, monthly_committed_micros: 10_000, active_leases: 1 }], error: null }
  if (name === 'moxscore_mark_ai_provider_contacted') return { data: true, error: null }
  return { data: true, error: null }
}

function validProviderText(): string {
  return JSON.stringify({
    schemaVersion: AI_TUNE_PROVIDER_SCHEMA,
    explanations: [{
      pairIndex: 0,
      cut: 'Cancel',
      add: 'Arcane Denial',
      reasoning: 'Arcane Denial replaces Cancel while preserving the supplied counterspell role.',
    }],
  })
}

describe('/api/tune constrained Pro explanations', () => {
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => rpcSuccess(name))
    mocks.access.mockResolvedValue({ kind: 'ready', user: { id: 'user-1' }, db: { rpc: mocks.rpc } })
    mocks.resolveEntitlement.mockResolvedValue({ kind: 'ready', entitlement })
    mocks.requireCapability.mockReturnValue({ ok: true, entitlement })
    mocks.providerEnabled.mockReturnValue(true)
    mocks.providerConfig.mockReturnValue({ provider: 'openai', model: 'approved-model', apiKey: 'secret' })
    mocks.controls.mockReturnValue(controls)
    mocks.complete.mockResolvedValue({ text: validProviderText(), provider: 'openai', model: 'approved-model', inputTokens: 100, outputTokens: 20 })
  })

  afterEach(() => vi.clearAllMocks())

  it.each([
    [{ kind: 'disabled' }, 404],
    [{ kind: 'unauthenticated' }, 401],
    [{ kind: 'unavailable' }, 503],
  ])('fails closed at the account boundary', async (access, status) => {
    mocks.access.mockResolvedValue(access)
    expect((await invoke()).statusCode).toBe(status)
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('requires the current server-derived capability before parsing input', async () => {
    mocks.requireCapability.mockReturnValue({ ok: false, status: 403, error: 'This feature is not available on your plan.' })
    const result = await invoke({ anything: 'forged' })
    expect(result.statusCode).toBe(403)
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('rejects non-v1 or invented-pair requests before quota consumption', async () => {
    const result = await invoke({ ...requestBody, extra: 'no' })
    expect(result.statusCode).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['switch_off', () => mocks.providerEnabled.mockReturnValue(false)],
    ['configuration_closed', () => mocks.providerConfig.mockReturnValue(null)],
    ['configuration_closed', () => mocks.controls.mockReturnValue(null)],
  ])('uses deterministic output with zero provider calls for %s', async (reason, configure) => {
    configure()
    const result = await invoke()
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({ providerCalled: false, fallbackReason: reason, providerOutcome: 'fallback' })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('does not consume quota or call a provider when the conservative input bound is exceeded', async () => {
    mocks.controls.mockReturnValue({ ...controls, maxInputTokens: 1 })
    const result = await invoke()
    expect(result.body).toMatchObject({ providerCalled: false, fallbackReason: 'input_too_large' })
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith('moxscore_claim_ai_explanation', expect.anything())
  })

  it('returns a durable conflict for request-id reuse with different input', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_claim_ai_explanation'
      ? { data: [{ decision: 'request_conflict', month_used: 1, day_used: 1, cached_response: null }], error: null }
      : rpcSuccess(name))
    expect(await invoke()).toMatchObject({ statusCode: 409 })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('returns retryable failure with zero provider calls when quota storage is unavailable', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_claim_ai_explanation'
      ? { data: null, error: { message: 'storage down' } }
      : rpcSuccess(name))
    const result = await invoke()
    expect(result).toEqual({ statusCode: 503, body: { error: 'AI controls are temporarily unavailable.' } })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('replays a validated completed response without a provider call', async () => {
    const parsed = parseAiTuneRequest(requestBody)!
    const cached = deterministicExplanationSet(parsed, 'provider_error')
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_claim_ai_explanation'
      ? { data: [{ decision: 'completed', month_used: 1, day_used: 1, cached_response: cached }], error: null }
      : rpcSuccess(name))
    const result = await invoke()
    expect(result.body).toMatchObject({ replayed: true, providerCalled: false, fallbackReason: 'provider_error' })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it.each([
    ['in_progress', 'request_in_progress'],
    ['ambiguous_provider', 'request_in_progress'],
    ['monthly_limit', 'quota_exhausted'],
    ['daily_limit', 'quota_exhausted'],
    ['burst_limit', 'quota_exhausted'],
  ])('keeps deterministic output for claim decision %s', async (decision, fallbackReason) => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_claim_ai_explanation'
      ? { data: [{ decision, month_used: 50, day_used: 10, cached_response: null }], error: null }
      : rpcSuccess(name))
    expect((await invoke()).body).toMatchObject({ fallbackReason, providerCalled: false })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it.each([
    ['daily_budget', 'budget_exhausted'],
    ['monthly_budget', 'budget_exhausted'],
    ['concurrency', 'concurrency_busy'],
  ])('refunds quota before provider when capacity denies %s', async (reason, fallbackReason) => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_reserve_ai_provider_capacity'
      ? { data: [{ allowed: false, reason, daily_committed_micros: 100_000, monthly_committed_micros: 100_000, active_leases: 2 }], error: null }
      : rpcSuccess(name))
    expect((await invoke()).body).toMatchObject({ fallbackReason, providerCalled: false })
    expect(mocks.rpc).toHaveBeenCalledWith('moxscore_refund_ai_quota', { p_request_id: requestId })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('refunds quota and makes no provider call when capacity storage is unavailable', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_reserve_ai_provider_capacity'
      ? { data: null, error: { message: 'storage down' } }
      : rpcSuccess(name))
    const result = await invoke()
    expect(result.body).toMatchObject({ providerCalled: false, fallbackReason: 'control_unavailable' })
    expect(mocks.rpc).toHaveBeenCalledWith('moxscore_refund_ai_quota', { p_request_id: requestId })
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('marks provider contact durably before making the single provider call', async () => {
    const result = await invoke()
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({ providerCalled: true, providerOutcome: 'success', fallbackReason: null })
    expect((result.body.explanations as Array<{ cut: string; add: string; source: string }>)[0]).toEqual(expect.objectContaining({ cut: 'Cancel', add: 'Arcane Denial', source: 'provider' }))
    const calls = mocks.rpc.mock.calls.map(([name]) => name)
    expect(calls.indexOf('moxscore_mark_ai_provider_contacted')).toBeLessThan(calls.indexOf('moxscore_record_ai_cost'))
    expect(mocks.complete).toHaveBeenCalledTimes(1)
  })

  it('charges ambiguous provider failures and returns deterministic explanations', async () => {
    mocks.complete.mockRejectedValue(new Error('timeout detail'))
    const result = await invoke()
    expect(result.body).toMatchObject({ providerCalled: true, providerOutcome: 'provider_error', fallbackReason: 'provider_error' })
    expect(mocks.rpc).toHaveBeenCalledWith('moxscore_record_ai_cost', expect.objectContaining({ p_estimated_cost_micros: controls.reservationMicros }))
    expect(mocks.rpc).not.toHaveBeenCalledWith('moxscore_refund_ai_quota', expect.anything())
  })

  it('rejects malformed provider output without accepting substitutions', async () => {
    mocks.complete.mockResolvedValue({ text: '{not json', provider: 'openai', model: 'approved-model', inputTokens: 10, outputTokens: 5 })
    const result = await invoke()
    expect(result.body).toMatchObject({ providerCalled: true, providerOutcome: 'invalid_output', fallbackReason: 'invalid_output' })
    expect((result.body.explanations as Array<{ source: string }>)[0]?.source).toBe('deterministic')
  })

  it('fails closed and refunds if the durable contact marker cannot be written', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'moxscore_mark_ai_provider_contacted'
      ? { data: false, error: { message: 'down' } }
      : rpcSuccess(name))
    const result = await invoke()
    expect(result.body).toMatchObject({ providerCalled: false, fallbackReason: 'control_unavailable' })
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledWith('moxscore_refund_ai_quota', { p_request_id: requestId })
  })

  it.each(['moxscore_record_ai_cost', 'moxscore_complete_ai_explanation'])('reports provider contact truthfully when %s storage fails after the call', async (failedRpc) => {
    mocks.rpc.mockImplementation(async (name: string) => name === failedRpc
      ? { data: null, error: { message: 'storage down' } }
      : rpcSuccess(name))
    const result = await invoke()
    expect(result.body).toMatchObject({ providerCalled: true, fallbackReason: 'control_unavailable', providerOutcome: 'fallback' })
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).not.toHaveBeenCalledWith('moxscore_refund_ai_quota', expect.anything())
  })
})
