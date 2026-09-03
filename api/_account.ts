import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireUser, type RequestUser } from './_auth.js'
import { serverFeatureEnabled, type ServerFeature } from './_featureFlags.js'

type Headers = Record<string, string | string[] | undefined> | undefined

export type AccountAccess =
  | { kind: 'disabled' }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; user: RequestUser; db: SupabaseClient }

/** Common account boundary for server-only v2 APIs. */
export async function accountAccess(headers: Headers, feature: ServerFeature = 'accounts'): Promise<AccountAccess> {
  if (!serverFeatureEnabled('accounts') || !serverFeatureEnabled(feature)) return { kind: 'disabled' }

  const auth = await requireUser(headers)
  if (auth.kind !== 'authenticated') return auth

  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (!url || !serviceRoleKey) return { kind: 'unavailable' }

  return {
    kind: 'ready',
    user: auth.user,
    db: createClient(url, serviceRoleKey, { auth: { persistSession: false } }),
  }
}

export function accountError(access: Exclude<AccountAccess, { kind: 'ready' }>): { status: number; error: string } {
  if (access.kind === 'disabled') return { status: 404, error: 'Not available' }
  if (access.kind === 'unauthenticated') return { status: 401, error: 'Authentication required' }
  return { status: 503, error: 'Account service is temporarily unavailable.' }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
