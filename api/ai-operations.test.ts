import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))

import handler from './_routes/ops/ai'

const emptyWindow = {
  request_count: 0, provider_call_count: 0, fallback_count: 0, quota_denial_count: 0, error_count: 0,
  input_tokens: 0, output_tokens: 0, estimated_cost_micros: 0, latency_total_ms: 0, latency_sample_count: 0,
}

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

async function invoke(headers: Record<string, string> = {}) {
  const { res, result } = createRes()
  await handler({ method: 'GET', headers }, res)
  return result
}

describe('/api/ai-ops aggregate surface', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('MOXSCORE_ENABLE_PRO_AI', 'true')
    vi.stubEnv('CRON_SECRET', 'operator-secret')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc })
    mocks.rpc.mockResolvedValue({ data: {
      today: { ...emptyWindow, request_count: 10, fallback_count: 2, latency_total_ms: 900, latency_sample_count: 3 },
      month: { ...emptyWindow, request_count: 40, estimated_cost_micros: 800_000 },
      active_provider_leases: 1,
      raw_prompt: 'must never escape',
      owner_id: 'must never escape',
    }, error: null })
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

  it('is absent while the Pro surface is closed', async () => {
    vi.stubEnv('MOXSCORE_ENABLE_PRO_AI', 'false')
    expect((await invoke()).statusCode).toBe(404)
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('requires the operator bearer secret', async () => {
    expect((await invoke()).statusCode).toBe(401)
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('returns redacted aggregate metrics without request, user, model, or prompt data', async () => {
    const result = await invoke({ authorization: 'Bearer operator-secret' })
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      summary: { today: { fallback_percentage: 20, average_latency_ms: 300 }, active_provider_leases: 1 },
      budget: { configured: false },
    })
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toMatch(/request[_-]?id|owner|email|model|prompt|reasoning/i)
    expect(mocks.rpc).toHaveBeenCalledWith('moxscore_ai_operations_summary')
  })

  it('reports only aggregate budget posture when owner controls are configured', async () => {
    vi.stubEnv('MOXSCORE_AI_DAILY_BUDGET_MICROS', '100000')
    vi.stubEnv('MOXSCORE_AI_MONTHLY_BUDGET_MICROS', '1000000')
    vi.stubEnv('MOXSCORE_AI_CONCURRENCY_LIMIT', '2')
    vi.stubEnv('MOXSCORE_AI_INPUT_COST_PER_MILLION_MICROS', '1000000')
    vi.stubEnv('MOXSCORE_AI_OUTPUT_COST_PER_MILLION_MICROS', '1000000')
    const result = await invoke({ authorization: 'Bearer operator-secret' })
    expect(result.body).toMatchObject({ budget: { configured: true, monthly_percentage: 80, warning: true, exhausted: false } })
  })
})
