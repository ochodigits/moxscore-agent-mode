import { describe, expect, it } from 'vitest'
import { durableRateLimitConfigured, enforcePublicRateLimit } from './_rateLimit'

const headers = { 'x-forwarded-for': '203.0.113.25' }
const options = { scope: 'test', limit: 100, windowMs: 60_000 }

describe('public abuse-control boundary', () => {
  it('does not treat the local bucket as a Production rate limit', () => {
    expect(enforcePublicRateLimit(headers, options, { VERCEL_ENV: 'production' })).toBe('unconfigured')
  })

  it('requires the server-only Vercel Firewall marker in Production', () => {
    const env = { VERCEL_ENV: 'production', MOXSCORE_DURABLE_RATE_LIMIT: 'vercel-firewall' }
    expect(durableRateLimitConfigured(env)).toBe(true)
    expect(enforcePublicRateLimit(headers, options, env)).toBe('allowed')
  })

  it('keeps a bounded local limiter for development and tests', () => {
    expect(enforcePublicRateLimit(headers, options, { VERCEL_ENV: 'preview' })).toBe('allowed')
  })
})
