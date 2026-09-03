import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/me'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = {
    status(code: number) { result.statusCode = code; return res },
    json(body: unknown) { result.body = body },
  }
  return { res, result }
}

describe('/api/me', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('stays unavailable until the server-side accounts flag is enabled', async () => {
    vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'false')
    const { res, result } = createRes()
    await handler({ method: 'GET' }, res)
    expect(result).toEqual({ statusCode: 404, body: { error: 'Not available' } })
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('requires a verified bearer token when accounts are enabled', async () => {
    vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
    vi.stubEnv('VERCEL_ENV', 'preview')
    const { res, result } = createRes()
    await handler({ method: 'GET', headers: {} }, res)
    expect(result).toEqual({ statusCode: 401, body: { error: 'Authentication required' } })
  })

  it('returns only server-owned default capabilities for an authenticated user', async () => {
    vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: 'player@example.com' } }, error: null })
    const maybeSingle = vi.fn().mockResolvedValue({ data: {
      id: 'user-1', display_name: null, locale: 'en', created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z', deletion_requested_at: null,
    }, error: null })
    const from = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) }) })
    createClientMock
      .mockReturnValueOnce({ auth: { getUser } })
      .mockReturnValueOnce({ from })

    const { res, result } = createRes()
    await handler({ method: 'GET', headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      profile: { id: 'user-1', locale: 'en' },
      plan: 'free',
      capabilities: { saved_decks: false, ai_explanations: false, discord_pod_check: false },
      limits: { savedDecks: 10, versionsPerDeck: 20, collectionCards: 10_000, aiSessionsPerMonth: 0 },
      quotas: {
        ai_explanations: {
          monthly_limit: 0, monthly_used: 0, monthly_remaining: 0,
          daily_limit: 0, daily_used: 0, daily_remaining: 0,
        },
      },
    })
    expect(getUser).toHaveBeenCalledWith('verified-token')
  })

  it('returns current durable AI quota only for a server-derived Pro capability', async () => {
    vi.stubEnv('MOXSCORE_ENABLE_ACCOUNTS', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_BILLING', 'true')
    vi.stubEnv('MOXSCORE_ENABLE_PRO_AI', 'true')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    vi.stubEnv('STRIPE_PRO_MONTHLY_PRICE_ID', 'price_monthly')
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: 'player@example.com' } }, error: null })
    const profile = {
      id: 'user-1', display_name: null, locale: 'en', created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z', deletion_requested_at: null,
    }
    const subscriptions = [{
      status: 'active', price_key: 'pro_monthly', current_period_end: '2099-01-01T00:00:00Z', cancel_at_period_end: false, reconciliation_blocked: false,
    }]
    const from = vi.fn((table: string) => table === 'profiles'
      ? { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }) }) }) }
      : { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: subscriptions, error: null }) }) })
    const rpc = vi.fn().mockResolvedValue({ data: {
      monthly_limit: 50, monthly_used: 7, monthly_remaining: 43,
      daily_limit: 10, daily_used: 2, daily_remaining: 8,
    }, error: null })
    createClientMock
      .mockReturnValueOnce({ auth: { getUser } })
      .mockReturnValueOnce({ from, rpc })

    const { res, result } = createRes()
    await handler({ method: 'GET', headers: { authorization: 'Bearer verified-token' } }, res)

    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      plan: 'pro', capabilities: { ai_explanations: true }, limits: { aiSessionsPerMonth: 50 },
      quotas: { ai_explanations: { monthly_limit: 50, monthly_used: 7, monthly_remaining: 43, daily_limit: 10, daily_used: 2, daily_remaining: 8 } },
    })
    expect(rpc).toHaveBeenCalledWith('moxscore_ai_quota_summary', { p_owner_id: 'user-1', p_monthly_limit: 50, p_daily_limit: 10 })
  })
})
