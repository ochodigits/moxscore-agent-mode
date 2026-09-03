interface SupabaseErrorLike {
  code?: unknown
  message?: unknown
}

import { currentRequestId } from './_requestContext.js'

function clean(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500)
}

/** Log only operational metadata. Never pass request bodies, keys, or decklists. */
export function logSupabaseError(endpoint: string, operation: string, error: unknown): void {
  const upstream = typeof error === 'object' && error !== null ? (error as SupabaseErrorLike) : {}
  console.error(JSON.stringify({
    event: 'supabase_error',
    request_id: currentRequestId() ?? 'unavailable',
    endpoint,
    operation,
    code: clean(upstream.code, 'unknown'),
    message: clean(upstream.message, error instanceof Error ? error.message : 'Unknown upstream error'),
  }))
}
