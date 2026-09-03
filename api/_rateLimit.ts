// Development-only local limiter. Production public boundaries require the
// documented Vercel Firewall rule and fail closed if its deployment marker is
// absent; a warm-instance Map is never treated as a durable control.

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 10_000

export interface RateLimitOptions {
  /** Max requests per window per IP. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Namespace so different endpoints get independent buckets. */
  scope: string
}

export function clientIp(headers: Record<string, string | string[] | undefined> | undefined): string {
  const fwd = headers?.['x-forwarded-for']
  const first = Array.isArray(fwd) ? fwd[0] : fwd
  // Vercel sets x-forwarded-for; the client IP is the first entry.
  return (first ?? '').split(',')[0]?.trim() || 'unknown'
}

/** Returns true when the request is allowed, false when rate-limited. */
export function checkRateLimit(ip: string, opts: RateLimitOptions): boolean {
  const now = Date.now()
  const key = `${opts.scope}:${ip}`

  // Opportunistic cleanup plus oldest-entry eviction keeps warm instances bounded.
  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k)
    }
    while (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value as string | undefined
      if (oldest === undefined) break
      buckets.delete(oldest)
    }
  }

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
    return true
  }
  bucket.count += 1
  return bucket.count <= opts.limit
}

type ServerEnv = Record<string, string | undefined>
export type PublicRateLimitResult = 'allowed' | 'limited' | 'unconfigured'

function isProduction(env: ServerEnv): boolean {
  return env.VERCEL_ENV === 'production' || (env.VERCEL_ENV === undefined && env.NODE_ENV === 'production')
}

/**
 * This marker is set only after the matching Vercel Firewall rule is enabled
 * for the route group. It is deliberately not a browser variable.
 */
export function durableRateLimitConfigured(env: ServerEnv = process.env): boolean {
  return env.MOXSCORE_DURABLE_RATE_LIMIT === 'vercel-firewall'
}

export function enforcePublicRateLimit(
  headers: Record<string, string | string[] | undefined> | undefined,
  options: RateLimitOptions,
  env: ServerEnv = process.env,
): PublicRateLimitResult {
  if (isProduction(env) && !durableRateLimitConfigured(env)) return 'unconfigured'
  return checkRateLimit(clientIp(headers), options) ? 'allowed' : 'limited'
}
