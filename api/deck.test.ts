import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import handler from './_routes/deck'

function createRes() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: null }
  const res = { status(code: number) { result.statusCode = code; return res }, json(body: unknown) { result.body = body } }
  return { res, result }
}

function enableSharing() {
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
  vi.stubEnv('MOXSCORE_ENABLE_SHARING', 'true')
  vi.stubEnv('VITE_ENABLE_SHARING', 'true')
  vi.stubEnv('VITE_LEGAL_CONTROLLER_NAME', 'Example Operator')
  vi.stubEnv('VITE_PRIVACY_CONTACT_EMAIL', 'privacy@example.com')
  vi.stubEnv('VITE_SHARED_DECK_RETENTION_DAYS', '90')
}

describe('/api/deck share lifecycle', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it('stores a hash rather than the deletion capability when creating a share', async () => {
    enableSharing()
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    createClientMock.mockReturnValue({ from })
    const { res, result } = createRes()

    await handler({
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ decklist: '1 Sol Ring', score: 80 }),
    }, res)

    expect(result.statusCode).toBe(201)
    const receipt = result.body as { slug: string; deletionToken: string; expiresAt: string }
    expect(receipt.slug).toMatch(/^[a-z0-9]{8}$/)
    expect(receipt.deletionToken).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.expiresAt).toEqual(expect.any(String))
    const inserted = insert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(inserted.deletion_token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(inserted.deletion_token_hash).not.toBe(receipt.deletionToken)
    expect(inserted.expires_at).toEqual(receipt.expiresAt)
  })

  it('deletes only through the supplied capability without revealing a mismatch', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const hashedEq = vi.fn().mockResolvedValue({ error: null })
    const slugEq = vi.fn().mockReturnValue({ eq: hashedEq })
    const remove = vi.fn().mockReturnValue({ eq: slugEq })
    const from = vi.fn().mockReturnValue({ delete: remove })
    createClientMock.mockReturnValue({ from })
    const { res, result } = createRes()

    await handler({
      method: 'DELETE', query: { slug: 'abc123de' },
      body: JSON.stringify({ deletionToken: 'a'.repeat(64) }),
    }, res)

    expect(result).toEqual({ statusCode: 204, body: {} })
    expect(slugEq).toHaveBeenCalledWith('slug', 'abc123de')
    expect(hashedEq).toHaveBeenCalledWith('deletion_token_hash', expect.not.stringMatching(/^a{64}$/))
  })

  it('excludes expired shares from normal lookup', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only')
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const expiresGt = vi.fn().mockReturnValue({ maybeSingle })
    const slugEq = vi.fn().mockReturnValue({ gt: expiresGt })
    const from = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: slugEq }) })
    createClientMock.mockReturnValue({ from })
    const { res, result } = createRes()

    await handler({ method: 'GET', query: { slug: 'abc123de' } }, res)

    expect(result).toEqual({ statusCode: 404, body: { error: 'Deck not found' } })
    expect(expiresGt).toHaveBeenCalledWith('expires_at', expect.any(String))
  })
})
