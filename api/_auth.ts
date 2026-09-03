import { createClient } from '@supabase/supabase-js'

type ServerEnv = Record<string, string | undefined>

export interface RequestUser {
  id: string
  email: string | null
}

export type RequestAuth =
  | { kind: 'authenticated'; user: RequestUser }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' }

type Headers = Record<string, string | string[] | undefined> | undefined

function headerValue(headers: Headers, name: string): string | undefined {
  const exact = headers?.[name] ?? headers?.[name.toLowerCase()]
  return Array.isArray(exact) ? exact[0] : exact
}

export function bearerToken(headers: Headers): string | null {
  const value = headerValue(headers, 'authorization')?.trim() ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(value)
  return match?.[1] ?? null
}

/**
 * Supabase verifies the bearer with auth.getUser before this timestamp is used
 * by an account endpoint. The JWT iat then lets the endpoint require a fresh
 * magic-link session without trusting any client-supplied time.
 */
export function bearerIssuedAt(headers: Headers): number | null {
  const token = bearerToken(headers)
  if (token === null) return null
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { iat?: unknown }
    return typeof parsed.iat === 'number' && Number.isFinite(parsed.iat) ? parsed.iat : null
  } catch {
    return null
  }
}

export function hasRecentBearerSession(headers: Headers, nowMs = Date.now(), maxAgeSeconds = 15 * 60): boolean {
  const issuedAt = bearerIssuedAt(headers)
  if (issuedAt === null) return false
  const ageSeconds = nowMs / 1000 - issuedAt
  return ageSeconds >= -60 && ageSeconds <= maxAgeSeconds
}

/**
 * Resolves the actual Supabase Auth user for a bearer token. It never accepts
 * a user id, email, role, or plan supplied in a request body or query string.
 */
export async function requireUser(headers: Headers, env: ServerEnv = process.env): Promise<RequestAuth> {
  const token = bearerToken(headers)
  if (token === null) return { kind: 'unauthenticated' }

  const url = env.SUPABASE_URL?.trim()
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return { kind: 'unavailable' }

  try {
    const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
    const { data, error } = await supabase.auth.getUser(token)
    if (error || data.user === null) return { kind: 'unauthenticated' }
    return { kind: 'authenticated', user: { id: data.user.id, email: data.user.email ?? null } }
  } catch {
    return { kind: 'unavailable' }
  }
}
