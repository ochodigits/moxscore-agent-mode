import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

type Params = Record<string, unknown>

const state: {
  access: unknown
  sessionCreate: Mock<(params: Params, options?: Params) => Promise<{ url?: string }>>
  portalCreate: Mock<(params: Params) => Promise<{ url: string }>>
  customerId: string | null
  origin: string | null
  pendingDeletion: unknown[]
  pendingDeletionError: unknown
  portalLookup: Mock<() => Promise<{ data: unknown; error: unknown }>>
  checkoutEnabled: boolean
} = {
  access: null,
  sessionCreate: vi.fn(),
  portalCreate: vi.fn(),
  customerId: 'cus_1',
  origin: 'https://moxscore.com',
  pendingDeletion: [],
  pendingDeletionError: null,
  portalLookup: vi.fn(),
  checkoutEnabled: true,
}

vi.mock('./_account.js', () => ({
  accountAccess: async () => state.access,
  accountError: (access: { kind: string }) => {
    if (access.kind === 'disabled') return { status: 404, error: 'Not available' }
    if (access.kind === 'unauthenticated') return { status: 401, error: 'Authentication required' }
    return { status: 503, error: 'Account service is temporarily unavailable.' }
  },
}))

vi.mock('./_billing.js', async () => {
  const actual = await vi.importActual<typeof import('./_billing')>('./_billing')
  return {
    ...actual,
    stripeClient: () => ({
      checkout: {
        sessions: { create: (params: Params, options?: Params) => state.sessionCreate(params, options) },
      },
      billingPortal: { sessions: { create: (params: Params) => state.portalCreate(params) } },
    }),
    priceIdFor: (key: string) => (key === 'pro_monthly' ? 'price_live_monthly' : 'price_live_annual'),
    ensureCustomer: async () => state.customerId,
    publicOrigin: () => state.origin,
  }
})

vi.mock('./_operationalFlags.js', () => ({
  billingOperationEnabled: (operation: string) => operation !== 'checkout' || state.checkoutEnabled,
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

async function invokeCheckout(req: Record<string, unknown>) {
  const { default: handler } = await import('./_routes/checkout.js')
  const { res, result } = recorder()
  await handler(req as never, res as never)
  return result
}

const readyAccess = {
  kind: 'ready',
  user: { id: 'user-1', email: 'player@example.com' },
  db: {
    from: (table: string) => {
      if (table === 'account_deletion_receipts') {
        const query = {
          select: () => query,
          eq: () => query,
          is: () => query,
          gt: () => query,
          limit: async () => ({ data: state.pendingDeletion, error: state.pendingDeletionError }),
        }
        return query
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => state.portalLookup() }) }) }
    },
  },
}

beforeEach(() => {
  vi.resetModules()
  state.access = readyAccess
  state.customerId = 'cus_1'
  state.origin = 'https://moxscore.com'
  state.pendingDeletion = []
  state.pendingDeletionError = null
  state.sessionCreate = vi.fn(async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }))
  state.portalCreate = vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/test' }))
  state.portalLookup = vi.fn(async () => ({ data: { provider_customer_id: 'cus_1' }, error: null }))
  state.checkoutEnabled = true
})

describe('checkout price handling', () => {
  it('creates a session for an allowlisted plan key', async () => {
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test' })
    expect(state.sessionCreate.mock.calls[0]?.[0]).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      line_items: [{ price: 'price_live_monthly', quantity: 1 }],
    })
  })

  it('refuses a raw Stripe price id supplied by the client', async () => {
    // The browser may name a plan key, never a price. This is the control that
    // stops a caller subscribing themselves at an arbitrary price.
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"price_live_monthly"}' })
    expect(result.statusCode).toBe(400)
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })

  it('refuses a missing or malformed plan key', async () => {
    for (const body of ['{}', '{"priceKey":null}', '{"priceKey":"free"}', 'not json']) {
      const result = await invokeCheckout({ method: 'POST', headers: {}, body })
      expect(result.statusCode).toBe(400)
    }
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })

  it('uses a per-user idempotency key so a double click reuses the session', async () => {
    await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_annual"}' })
    expect(state.sessionCreate.mock.calls[0]?.[1]).toEqual({ idempotencyKey: 'checkout:user-1:pro_annual' })
  })
})

describe('checkout access control', () => {
  it('returns 404 when billing is switched off', async () => {
    state.access = { kind: 'disabled' }
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(404)
  })

  it('closes new Checkout independently of the billing master', async () => {
    state.checkoutEnabled = false
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(404)
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })

  it('requires authentication', async () => {
    state.access = { kind: 'unauthenticated' }
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(401)
  })

  it('blocks a new subscription while account deletion is pending', async () => {
    state.pendingDeletion = [{ token_hash: 'redacted' }]
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(409)
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })

  it('rejects a non-POST request', async () => {
    const result = await invokeCheckout({ method: 'GET', headers: {} })
    expect(result.statusCode).toBe(405)
  })

  it('leaks no provider detail when Stripe fails', async () => {
    state.sessionCreate = vi.fn(async () => {
      throw new Error('No such price: price_live_monthly in account acct_123')
    })
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(503)
    expect(JSON.stringify(result.body)).not.toContain('acct_123')
    expect(JSON.stringify(result.body)).not.toContain('price_live_monthly')
  })

  it('creates no provider session when the return origin is unconfigured', async () => {
    state.origin = null
    const result = await invokeCheckout({ method: 'POST', headers: {}, body: '{"priceKey":"pro_monthly"}' })
    expect(result.statusCode).toBe(503)
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })
})

describe('portal', () => {
  async function invokePortal(req: Record<string, unknown>) {
    const { default: handler } = await import('./_routes/portal.js')
    const { res, result } = recorder()
    await handler(req as never, res as never)
    return result
  }

  it('opens the portal for an existing customer', async () => {
    const result = await invokePortal({ method: 'POST', headers: {} })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ url: 'https://billing.stripe.com/p/session/test' })
    expect(state.portalCreate.mock.calls[0]?.[0]).toMatchObject({ customer: 'cus_1' })
  })

  it('does not create a customer for someone who never subscribed', async () => {
    state.portalLookup = vi.fn(async () => ({ data: null, error: null }))
    const result = await invokePortal({ method: 'POST', headers: {} })
    expect(result.statusCode).toBe(404)
    expect(state.portalCreate).not.toHaveBeenCalled()
  })

  it('never accepts a customer id from the request', async () => {
    // The customer is resolved from the authenticated user, so a supplied id
    // cannot open someone else's billing portal.
    await invokePortal({ method: 'POST', headers: {}, body: '{"customer":"cus_victim"}' })
    expect(state.portalCreate.mock.calls[0]?.[0]).toMatchObject({ customer: 'cus_1' })
  })

  it('keeps the Portal available when only new Checkout is disabled', async () => {
    state.checkoutEnabled = false
    const result = await invokePortal({ method: 'POST', headers: {} })
    expect(result.statusCode).toBe(200)
    expect(state.portalCreate).toHaveBeenCalledOnce()
  })
})
