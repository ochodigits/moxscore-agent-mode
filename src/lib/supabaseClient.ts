import type { SupabaseClient } from '@supabase/supabase-js'

interface PublicAuthEnv {
  VITE_ENABLE_ACCOUNTS?: string
  VITE_ENABLE_PERSISTENCE?: string
  VITE_ENABLE_COLLECTIONS?: string
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_ANON_KEY?: string
}

export interface PublicAuthConfig {
  enabled: boolean
  url: string | null
  anonKey: string | null
}

function value(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Accounts are optional. A missing or incomplete public configuration must
 * leave the anonymous analyzer functional rather than throwing at import time.
 */
export function publicAuthConfig(env: PublicAuthEnv = import.meta.env as PublicAuthEnv): PublicAuthConfig {
  const url = value(env.VITE_SUPABASE_URL)
  const anonKey = value(env.VITE_SUPABASE_ANON_KEY)
  return {
    enabled: env.VITE_ENABLE_ACCOUNTS === 'true' && url !== null && anonKey !== null,
    url,
    anonKey,
  }
}

let clientPromise: Promise<SupabaseClient | null> | undefined

/**
 * Keep the Auth SDK out of the anonymous v1 bundle. The dynamic import runs
 * only in a deliberately configured account environment.
 */
export function getSupabaseClient(): Promise<SupabaseClient | null> {
  if (clientPromise !== undefined) return clientPromise
  const config = publicAuthConfig()
  if (!config.enabled || config.url === null || config.anonKey === null) {
    clientPromise = Promise.resolve(null)
    return clientPromise
  }
  clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(config.url!, config.anonKey!, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
  )
  return clientPromise
}

export function accountsUiEnabled(): boolean {
  return publicAuthConfig().enabled
}

export function persistenceUiEnabled(env: PublicAuthEnv = import.meta.env as PublicAuthEnv): boolean {
  return publicAuthConfig(env).enabled && env.VITE_ENABLE_PERSISTENCE === 'true'
}

/** Collections are an optional Preview workflow layered on saved persistence. */
export function collectionsUiEnabled(env: PublicAuthEnv = import.meta.env as PublicAuthEnv): boolean {
  return persistenceUiEnabled(env) && env.VITE_ENABLE_COLLECTIONS === 'true'
}
