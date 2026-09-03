import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * The webhook's collaborators are all module-level, so each test installs its
 * own doubles and re-imports the handler. Nothing here reaches a network or a
 * database.
 */
interface EventLike {
  id: string
  type: string
  created: number
  data: { object: Record<string, unknown> }
}

type RpcResult = Promise<{ data: unknown; error: unknown }>

const state: {
  constructEvent: Mock<(raw: string, signature: string, secret: string) => EventLike>
  rpc: Mock<(fn: string, params?: Record<string, unknown>) => RpcResult>
  maybeSingle: Mock<() => RpcResult>
  retrieve: Mock<(id: string) => Promise<Record<string, unknown>>>
  projectionEnabled: boolean
} = {
  constructEvent: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  retrieve: vi.fn(),
  projectionEnabled: true,
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (fn: string, params?: Record<string, unknown>) => state.rpc(fn, params),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => state.maybeSingle() }) }),
    }),
  }),
}))

vi.mock('./_billing.js', () => ({
  stripeClient: () => ({
    webhooks: {
      constructEvent: (raw: string, signature: string, secret: string) =>
        state.constructEvent(raw, signature, secret),
    },
    subscriptions: { retrieve: (id: string) => state.retrieve(id) },
  }),
  webhookSecret: () => 'whsec_test',
  periodEndFrom: () => '2026-09-15T12:00:00.000Z',
  priceKeyFrom: () => 'pro_monthly',
}))

vi.mock('./_featureFlags.js', () => ({ serverFeatureEnabled: () => true }))
vi.mock('./_operationalFlags.js', () => ({
  billingOperationEnabled: (operation: string) => operation !== 'webhookProjection' || state.projectionEnabled,
}))

function recorder() {
  const result: { statusCode: number; body: unknown } = { statusCode: 0, body: null }
  const res = {
    status(code: number) {
      result.statusCode = code
      return res
    },
    json(body: unknown) {
      result.body = body
    },
  }
  return { res, result }
}

async function invoke(req: Record<string, unknown>) {
  const { default: handler } = await import('./_routes/stripe-webhook.js')
  const { res, result } = recorder()
  await handler(req as never, res as never)
  return result
}

const signedRequest = {
  method: 'POST',
  headers: { 'stripe-signature': 't=1,v1=abc' },
  rawBody: '{"id":"evt_1"}',
}

function subscriptionEvent(overrides: Partial<EventLike> = {}): EventLike {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1_789_000_000,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_live_monthly' } }] },
      },
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetModules()
  state.constructEvent = vi.fn(() => subscriptionEvent())
  state.rpc = vi.fn(async (fn: string) =>
    fn === 'moxscore_claim_webhook_event' ? { data: 'claimed', error: null } : { data: null, error: null },
  )
  state.maybeSingle = vi.fn(async () => ({ data: { owner_id: 'user-1' }, error: null }))
  state.retrieve = vi.fn(async () => subscriptionEvent().data.object)
  state.projectionEnabled = true
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
})

afterEach(() => {
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

describe('signature verification', () => {
  it('verifies against the exact raw bytes, not a reparsed body', async () => {
    await invoke(signedRequest)
    expect(state.constructEvent).toHaveBeenCalledWith('{"id":"evt_1"}', 't=1,v1=abc', 'whsec_test')
  })

  it('rejects an unverifiable payload before touching storage', async () => {
    state.constructEvent = vi.fn(() => {
      throw new Error('signature mismatch')
    })
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(400)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('rejects a request with no signature header', async () => {
    const result = await invoke({ ...signedRequest, headers: {} })
    expect(result.statusCode).toBe(400)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('rejects a request whose raw body never reached the route', async () => {
    // Guards against a router regression that re-enables body parsing.
    const result = await invoke({ ...signedRequest, rawBody: undefined, body: { id: 'evt_1' } })
    expect(result.statusCode).toBe(400)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-POST request', async () => {
    const result = await invoke({ ...signedRequest, method: 'GET' })
    expect(result.statusCode).toBe(405)
  })
})

describe('idempotency', () => {
  it('claims the event before performing any side effect', async () => {
    await invoke(signedRequest)
    expect(state.rpc.mock.calls[0]?.[0]).toBe('moxscore_claim_webhook_event')
  })

  it('acknowledges a duplicate without reprocessing it', async () => {
    state.rpc = vi.fn(async (fn: string) =>
      fn === 'moxscore_claim_webhook_event' ? { data: 'duplicate_processed', error: null } : { data: null, error: null },
    )
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({ duplicate: true })
    const projected = state.rpc.mock.calls.some((c) => c[0] === 'moxscore_project_subscription')
    expect(projected).toBe(false)
  })

  it('returns retryable 503 for a live duplicate lease', async () => {
    state.rpc = vi.fn(async (fn: string) =>
      fn === 'moxscore_claim_webhook_event' ? { data: 'retry_later', error: null } : { data: null, error: null },
    )
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(503)
    expect(state.rpc.mock.calls.some((call) => call[0] === 'moxscore_project_subscription')).toBe(false)
  })
})

describe('subscription projection', () => {
  it('re-reads subscription events and orders projection by the provider-read observation time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T12:30:00.000Z'))
    try {
      await invoke(signedRequest)
      expect(state.retrieve).toHaveBeenCalledWith('sub_1')
      const call = state.rpc.mock.calls.find((c) => c[0] === 'moxscore_project_subscription')
      expect(call?.[1]).toMatchObject({
        p_subscription_id: 'sub_1',
        p_customer_id: 'cus_1',
        p_owner_id: 'user-1',
        p_status: 'active',
        p_event_at: '2026-08-23T12:30:00.000Z',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves ownership from our customer table, never from event metadata', async () => {
    // A forged moxscore_user_id in Stripe metadata must not select the owner.
    state.constructEvent = vi.fn(() =>
      subscriptionEvent({
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            cancel_at_period_end: false,
            metadata: { moxscore_user_id: 'attacker' },
            items: { data: [{ price: { id: 'price_live_monthly' } }] },
          },
        },
      }),
    )
    await invoke(signedRequest)
    const call = state.rpc.mock.calls.find((c) => c[0] === 'moxscore_project_subscription')
    expect(call?.[1]).toMatchObject({ p_owner_id: 'user-1' })
  })

  it('ignores an event for a customer this environment does not own', async () => {
    state.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(200)
    const completion = state.rpc.mock.calls.find((c) => c[0] === 'moxscore_complete_webhook_event')
    expect(completion?.[1]).toMatchObject({ p_result: 'ignored' })
  })

  it('re-reads the subscription for invoice events rather than trusting the snapshot', async () => {
    state.constructEvent = vi.fn(() => ({
      id: 'evt_2',
      type: 'invoice.payment_failed',
      created: 1_789_000_000,
      data: { object: { subscription: 'sub_1' } },
    }))
    await invoke(signedRequest)
    expect(state.retrieve).toHaveBeenCalledWith('sub_1')
  })
})

describe('failure handling', () => {
  it('returns 500 and marks the attempt failed so Stripe retries', async () => {
    state.rpc = vi.fn(async (fn: string) => {
      if (fn === 'moxscore_claim_webhook_event') return { data: 'claimed', error: null }
      if (fn === 'moxscore_project_subscription') return { data: null, error: { message: 'outage' } }
      return { data: null, error: null }
    })
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(500)
    const completion = state.rpc.mock.calls.find((c) => c[0] === 'moxscore_complete_webhook_event')
    expect(completion?.[1]).toMatchObject({ p_result: 'failed' })
  })

  it('does not acknowledge projected work when ledger completion fails', async () => {
    state.rpc = vi.fn(async (fn: string) => {
      if (fn === 'moxscore_claim_webhook_event') return { data: 'claimed', error: null }
      if (fn === 'moxscore_complete_webhook_event') return { data: null, error: { message: 'ledger outage' } }
      return { data: null, error: null }
    })
    expect(await invoke(signedRequest)).toMatchObject({ statusCode: 500 })
    expect(state.rpc).toHaveBeenCalledWith('moxscore_complete_webhook_event', {
      p_event_id: 'evt_1', p_result: 'failed',
    })
  })

  it('returns 503 when entitlement storage is unconfigured, so delivery retries', async () => {
    delete process.env.SUPABASE_URL
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(503)
  })

  it('verifies a valid signature then returns retryable 503 when projection is disabled', async () => {
    state.projectionEnabled = false
    const result = await invoke(signedRequest)
    expect(result.statusCode).toBe(503)
    expect(state.constructEvent).toHaveBeenCalledOnce()
    expect(state.rpc).not.toHaveBeenCalled()
  })
})
