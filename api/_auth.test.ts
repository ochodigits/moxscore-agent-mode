import { afterEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }))

import { bearerToken, requireUser } from './_auth'

describe('server Auth boundary', () => {
  afterEach(() => vi.resetAllMocks())

  it('parses only a bearer token', () => {
    expect(bearerToken({ authorization: 'Bearer trusted-token' })).toBe('trusted-token')
    expect(bearerToken({ authorization: 'Basic anything' })).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })

  it('does not create a server client without a token or server-only configuration', async () => {
    expect(await requireUser({}, { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret' }))
      .toEqual({ kind: 'unauthenticated' })
    expect(await requireUser({ authorization: 'Bearer token' }, {})).toEqual({ kind: 'unavailable' })
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('resolves identity only through Supabase Auth', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: 'player@example.com' } }, error: null })
    createClientMock.mockReturnValue({ auth: { getUser } })

    await expect(requireUser(
      { authorization: 'Bearer verified-token' },
      { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only' },
    )).resolves.toEqual({ kind: 'authenticated', user: { id: 'user-1', email: 'player@example.com' } })
    expect(getUser).toHaveBeenCalledWith('verified-token')
  })

  it('treats invalid tokens as unauthenticated without echoing them', async () => {
    createClientMock.mockReturnValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } }) } })
    await expect(requireUser(
      { authorization: 'Bearer invalid-token' },
      { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only' },
    )).resolves.toEqual({ kind: 'unauthenticated' })
  })
})
