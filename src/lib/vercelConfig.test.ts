import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface RewriteRule {
  source: string
  destination: string
  has?: Array<{ type: string; key: string; value: string }>
}

interface VercelConfig {
  framework?: string
  installCommand?: string
  buildCommand?: string
  outputDirectory?: string
  rewrites?: RewriteRule[]
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  crons?: Array<{ path: string; schedule: string }>
}

const config = JSON.parse(
  readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'),
) as VercelConfig

describe('Vercel release configuration', () => {
  it('pins the same deterministic Vite artifact used by the release gate', () => {
    expect(config).toMatchObject({
      framework: 'vite',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
    })
  })

  it('keeps crawler sharing ahead of an SPA fallback that excludes APIs', () => {
    const rewrites = config.rewrites ?? []
    const crawlerIndex = rewrites.findIndex((rule) => rule.source === '/d/:slug')
    const spaIndex = rewrites.findIndex((rule) => rule.destination === '/index.html')
    const crawler = rewrites[crawlerIndex]
    const spa = rewrites[spaIndex]

    expect(crawlerIndex).toBeGreaterThanOrEqual(0)
    expect(spaIndex).toBeGreaterThan(crawlerIndex)
    expect(crawler?.has).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'header', key: 'user-agent' }),
    ]))
    expect(spa?.source).toContain('(?!api/)')
  })

  it('sets a CSP that permits card-data, optional account auth, and card images', () => {
    const security = config.headers?.find((rule) => rule.source === '/(.*)')?.headers ?? []
    const csp = security.find((header) => header.key === 'Content-Security-Policy')?.value ?? ''

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self' https://api.scryfall.com https://*.supabase.co wss://*.supabase.co https://openrouter.ai")
    expect(csp).toContain('img-src \'self\' data: blob: https://*.scryfall.io')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(security).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'X-Content-Type-Options', value: 'nosniff' }),
      expect.objectContaining({ key: 'X-Frame-Options', value: 'DENY' }),
    ]))
  })

  it('schedules authenticated cleanup for expired anonymous shares', () => {
    expect(config.crons).toContainEqual({ path: '/api/purge-expired-shares', schedule: '0 3 * * *' })
  })

  it('schedules the fail-closed daily billing reconciliation entrypoint', () => {
    expect(config.crons).toContainEqual({ path: '/api/reconcile-billing', schedule: '15 3 * * *' })
  })
})
