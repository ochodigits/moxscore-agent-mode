// Vercel serverless function: crawler-friendly share page with OpenGraph meta.
//
// GET /api/share?slug=abc123
//   - Serves minimal HTML with OG/Twitter meta (image -> /api/og) so links unfurl
//     in Discord/Slack/Twitter, then redirects human visitors to the SPA at /d/:slug.
//
// Why this exists: the app is a client-rendered SPA, so crawlers (which don't run
// JS) wouldn't see per-deck meta on /d/:slug. Point share links at this endpoint
// for rich unfurls. Humans are bounced to the real app instantly.

import { createClient } from '@supabase/supabase-js'
import { logSupabaseError } from '../_supabaseErrors.js'

// Explicit key selection, no silent fallback chain. The shared_decks table
// has no public read policy, so server-side reads use the service-role key
// scoped to a single-slug SELECT.
const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const SLUG_RE = /^[a-z0-9]{8}$/

// This HTML is cached at the CDN and contains a redirect target + og:url, so
// the origin must NOT be derived from the (spoofable) Host header — that
// would be a cacheable open redirect.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://moxscore.com'

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string)
}

interface VercelReq {
  query?: Record<string, string | string[] | undefined>
  headers?: Record<string, string | string[] | undefined>
}
interface VercelRes {
  status(code: number): VercelRes
  setHeader(k: string, v: string): void
  send(body: string): void
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const raw = req.query?.slug
  const rawSlug = Array.isArray(raw) ? raw[0] : raw
  const slug = rawSlug && SLUG_RE.test(rawSlug) ? rawSlug : undefined
  const origin = PUBLIC_ORIGIN

  let title = 'Commander deck health score'
  let description = 'Check your Commander deck health score on Moxscore.'
  if (slug && SUPABASE_URL && SUPABASE_KEY) {
    try {
      const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
      const { data, error } = await db.from('shared_decks').select('score, commander, name').eq('slug', slug).gt('expires_at', new Date().toISOString()).maybeSingle()
      if (error) logSupabaseError('/api/share', 'select', error)
      if (data) {
        const subject = data.commander ?? data.name ?? 'This deck'
        title = `${subject} scored ${data.score ?? 0}/100 on Moxscore`
        description = `See the full ramp, draw, interaction, curve, and wincon breakdown.`
      }
    } catch (error) {
      logSupabaseError('/api/share', 'select', error)
      /* defaults */
    }
  }

  const appUrl = slug ? `${origin}/d/${esc(slug)}` : origin
  const ogImage = slug ? `${origin}/api/og?slug=${esc(slug)}` : `${origin}/api/og`

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(description)}"/>
<meta property="og:image" content="${ogImage}"/>
<meta property="og:url" content="${appUrl}"/>
<meta property="og:type" content="website"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(description)}"/>
<meta name="twitter:image" content="${ogImage}"/>
<meta http-equiv="refresh" content="0; url=${appUrl}"/>
<link rel="canonical" href="${appUrl}"/>
</head>
<body>
<p>Redirecting to <a href="${appUrl}">your deck analysis</a>…</p>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600')
  res.status(200).send(html)
}
