import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ access: vi.fn(), resolve: vi.fn(), require: vi.fn(), rpc: vi.fn() }))
vi.mock('./_account.ts', () => ({
  accountAccess: (...args: unknown[]) => mocks.access(...args),
  accountError: (access: { kind: string }) => access.kind === 'disabled'
    ? { status: 404, error: 'Not available' }
    : { status: 401, error: 'Authentication required' },
}))
vi.mock('./_entitlement.ts', () => ({
  resolveEntitlement: (...args: unknown[]) => mocks.resolve(...args),
  requireCapability: (...args: unknown[]) => mocks.require(...args),
}))

import handler from './_routes/ai-feedback'

const requestId = '123e4567-e89b-42d3-a456-426614174000'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

async function invoke(body: unknown) {
  const { res, result } = createRes()
  await handler({ method: 'POST', body, headers: { authorization: 'Bearer token' } }, res)
  return result
}

describe('/api/ai-feedback', () => {
  beforeEach(() => {
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    mocks.access.mockResolvedValue({ kind: 'ready', user: { id: 'user-1' }, db: { rpc: mocks.rpc } })
    mocks.resolve.mockResolvedValue({ kind: 'ready' })
    mocks.require.mockReturnValue({ ok: true, entitlement: {} })
  })
  afterEach(() => vi.clearAllMocks())

  it('requires the Pro capability', async () => {
    mocks.require.mockReturnValue({ ok: false, status: 403, error: 'This feature is not available on your plan.' })
    expect((await invoke({ requestId, rating: 'up', reasonCode: 'helpful' })).statusCode).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { requestId: 'bad', rating: 'up', reasonCode: 'helpful' },
    { requestId, rating: 'sideways', reasonCode: 'helpful' },
    { requestId, rating: 'down', reasonCode: 'free text is forbidden' },
    { requestId, rating: 'up', reasonCode: 'helpful', comment: 'raw text' },
  ])('rejects unbounded or non-enumerated feedback %#', async (body) => {
    expect((await invoke(body)).statusCode).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('stores only request ownership, rating, and a bounded reason code', async () => {
    const result = await invoke(JSON.stringify({ requestId: requestId.toUpperCase(), rating: 'down', reasonCode: 'unsupported' }))
    expect(result).toEqual({ statusCode: 200, body: { recorded: true } })
    expect(mocks.rpc).toHaveBeenCalledWith('moxscore_record_ai_feedback', {
      p_owner_id: 'user-1', p_request_id: requestId, p_rating: 'down', p_reason_code: 'unsupported',
    })
  })

  it('does not reveal a request owned by another account', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0002' } })
    expect(await invoke({ requestId, rating: 'up', reasonCode: 'helpful' })).toEqual({
      statusCode: 404, body: { error: 'Explanation not found.' },
    })
  })
})
