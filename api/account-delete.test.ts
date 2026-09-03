import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountAccess: vi.fn(),
  billingEnabled: false,
  billingCustomerId: 'cus_owner',
  billingLookupError: null as unknown,
  billingCleanupError: null as unknown,
  deleteCustomer: vi.fn(),
  deleteUser: vi.fn(),
  retrieveCustomer: vi.fn(),
  stripeAvailable: true,
}))
vi.mock('./_account', () => ({
  accountAccess: mocks.accountAccess,
  accountError: () => ({ status: 503, error: 'unavailable' }),
}))
vi.mock('./_billing', () => ({
  stripeClient: () => mocks.stripeAvailable
    ? { customers: { retrieve: mocks.retrieveCustomer, del: mocks.deleteCustomer } }
    : null,
}))
vi.mock('./_featureFlags', () => ({
  serverFeatureEnabled: (feature: string) => feature === 'billing' && mocks.billingEnabled,
}))

import handler from './_routes/account-delete'

function bearer(ageSeconds = 0): string {
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) - ageSeconds })).toString('base64url')
  return `Bearer header.${payload}.signature`
}

function response() {
  const result: { statusCode: number; body: unknown } = { statusCode: 0, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { result, res }
}

function readyAccess() {
  const countQuery = { eq: vi.fn().mockResolvedValue({ count: 0, error: null }) }
  const receiptSelect = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { user_id: 'owner-a', expires_at: new Date(Date.now() + 60_000).toISOString(), completed_at: null },
      error: null,
    }),
  }
  receiptSelect.eq.mockReturnValue(receiptSelect)
  const receiptUpdate = { eq: vi.fn().mockResolvedValue({ error: null }) }
  const billingSelect = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockImplementation(async () => ({
      data: mocks.billingCustomerId ? { provider_customer_id: mocks.billingCustomerId } : null,
      error: mocks.billingLookupError,
    })),
  }
  billingSelect.eq.mockReturnValue(billingSelect)
  const db = {
    auth: { admin: { deleteUser: mocks.deleteUser } },
    from: vi.fn((table: string) => {
      if (table === 'account_deletion_receipts') {
        return { select: vi.fn(() => receiptSelect), update: vi.fn(() => receiptUpdate), insert: vi.fn().mockResolvedValue({ error: null }) }
      }
      if (table === 'billing_customers') return { select: vi.fn(() => billingSelect) }
      return { select: vi.fn(() => countQuery) }
    }),
    rpc: vi.fn().mockImplementation(async () => ({ error: mocks.billingCleanupError })),
  }
  mocks.accountAccess.mockResolvedValue({ kind: 'ready', user: { id: 'owner-a', email: 'a@example.test' }, db })
  return db
}

beforeEach(() => {
  mocks.billingEnabled = false
  mocks.billingCustomerId = 'cus_owner'
  mocks.billingLookupError = null
  mocks.billingCleanupError = null
  mocks.stripeAvailable = true
  mocks.deleteCustomer.mockReset().mockResolvedValue({ id: 'cus_owner', deleted: true })
  mocks.deleteUser.mockReset()
  mocks.retrieveCustomer.mockReset().mockResolvedValue({ id: 'cus_owner', deleted: false })
})

describe('/api/account-delete', () => {
  it('requires a fresh session before starting the irreversible flow', async () => {
    readyAccess()
    const { res, result } = response()
    await handler({ method: 'POST', headers: { authorization: bearer(16 * 60) }, body: JSON.stringify({ action: 'start' }) }, res)
    expect(result).toEqual({ statusCode: 401, body: { error: 'Recent sign-in required', code: 'RECENT_AUTH_REQUIRED' } })
  })

  it('does not delete until the explicit second confirmation is received', async () => {
    readyAccess()
    const { res, result } = response()
    await handler({ method: 'POST', headers: { authorization: bearer() }, body: JSON.stringify({ action: 'confirm', confirmation: 'no' }) }, res)
    expect(result.statusCode).toBe(400)
    expect(mocks.deleteUser).not.toHaveBeenCalled()
  })

  it('hard-deletes the Auth user and verifies the owner-scoped cascades', async () => {
    const db = readyAccess()
    mocks.deleteUser.mockResolvedValue({ error: null })
    const { res, result } = response()
    await handler({ method: 'POST', headers: { authorization: bearer() }, body: JSON.stringify({ action: 'confirm', confirmation: 'DELETE MY ACCOUNT', deletionRequestToken: 'a'.repeat(64) }) }, res)
    expect(mocks.deleteUser).toHaveBeenCalledWith('owner-a', false)
    expect(db.from).toHaveBeenCalledWith('profiles')
    expect(db.from).toHaveBeenCalledWith('saved_decks')
    expect(db.from).toHaveBeenCalledWith('collections')
    expect(result.statusCode).toBe(204)
  })

  it('deletes the Stripe customer and local billing projection before the Auth user', async () => {
    mocks.billingEnabled = true
    const db = readyAccess()
    mocks.deleteUser.mockResolvedValue({ error: null })
    const { res, result } = response()

    await handler({ method: 'POST', headers: { authorization: bearer() }, body: JSON.stringify({ action: 'confirm', confirmation: 'DELETE MY ACCOUNT', deletionRequestToken: 'a'.repeat(64) }) }, res)

    expect(mocks.retrieveCustomer).toHaveBeenCalledWith('cus_owner')
    expect(mocks.deleteCustomer).toHaveBeenCalledWith('cus_owner')
    expect(db.rpc).toHaveBeenCalledWith('moxscore_delete_billing_owner', { p_owner_id: 'owner-a' })
    expect(mocks.deleteCustomer.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteUser.mock.invocationCallOrder[0]!)
    expect(result.statusCode).toBe(204)
  })

  it('does not delete Auth when Stripe customer deletion fails', async () => {
    mocks.billingEnabled = true
    readyAccess()
    mocks.deleteCustomer.mockRejectedValue(new Error('provider unavailable'))
    const { res, result } = response()

    await handler({ method: 'POST', headers: { authorization: bearer() }, body: JSON.stringify({ action: 'confirm', confirmation: 'DELETE MY ACCOUNT', deletionRequestToken: 'a'.repeat(64) }) }, res)

    expect(result).toEqual({ statusCode: 503, body: { error: 'Account deletion is temporarily unavailable.' } })
    expect(mocks.deleteUser).not.toHaveBeenCalled()
  })

  it('retries local cleanup without deleting an already-deleted Stripe customer twice', async () => {
    mocks.billingEnabled = true
    const db = readyAccess()
    mocks.retrieveCustomer.mockResolvedValue({ id: 'cus_owner', deleted: true })
    mocks.deleteUser.mockResolvedValue({ error: null })
    const { res, result } = response()

    await handler({ method: 'POST', headers: { authorization: bearer() }, body: JSON.stringify({ action: 'confirm', confirmation: 'DELETE MY ACCOUNT', deletionRequestToken: 'a'.repeat(64) }) }, res)

    expect(mocks.deleteCustomer).not.toHaveBeenCalled()
    expect(db.rpc).toHaveBeenCalled()
    expect(result.statusCode).toBe(204)
  })
})
