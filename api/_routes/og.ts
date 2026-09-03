// Dynamic PNG Open Graph artwork for a shared deck. The public share route
// remains HTML for crawlers; this endpoint deliberately returns image/png.
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { logSupabaseError } from '../_supabaseErrors.js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const SLUG_RE = /^[a-z0-9]{8}$/

interface VercelReq { query?: Record<string, string | string[] | undefined> }
interface VercelRes {
  status(code: number): VercelRes
  setHeader(k: string, v: string): void
  send(body: string | Buffer): void
}

function color(score: number): string {
  if (score >= 75) return '#34d399'
  if (score >= 50) return '#fbbf24'
  return '#f87171'
}

function xml(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return ' '
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] ?? character)
  }).join('').slice(0, 48)
}

function imageSvg(commander: string, score: number, found: boolean): string {
  const accent = color(score)
  const label = found ? 'Commander deck health score' : 'Commander deck analysis'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0b0b14"/>
  <text x="72" y="104" font-family="Arial, sans-serif" font-size="34" font-weight="800" letter-spacing="4" fill="#a78bfa">MOXSCORE</text>
  <text x="72" y="302" font-family="Arial, sans-serif" font-size="58" font-weight="800" fill="#ffffff">${xml(commander)}</text>
  <text x="72" y="356" font-family="Arial, sans-serif" font-size="28" fill="#cbd5e1">${label}</text>
  <circle cx="1025" cy="315" r="124" fill="#0b0b14" stroke="${accent}" stroke-width="22"/>
  <text x="1025" y="344" text-anchor="middle" font-family="Arial, sans-serif" font-size="86" font-weight="800" fill="#ffffff">${score}</text>
</svg>`
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const raw = req.query?.slug
  const rawSlug = Array.isArray(raw) ? raw[0] : raw
  const slug = rawSlug && SLUG_RE.test(rawSlug) ? rawSlug : undefined
  let score = 0
  let commander = 'Commander deck'
  let found = !slug

  if (slug && SUPABASE_URL && SUPABASE_KEY) {
    try {
      const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
      const { data, error } = await db.from('shared_decks').select('score, commander, name').eq('slug', slug).gt('expires_at', new Date().toISOString()).maybeSingle()
      if (error) logSupabaseError('/api/og', 'select', error)
      if (data) {
        found = true
        score = Math.max(0, Math.min(100, Math.round(data.score ?? 0)))
        commander = data.commander ?? data.name ?? commander
      }
    } catch (error) {
      logSupabaseError('/api/og', 'select', error)
    }
  }

  const png = await sharp(Buffer.from(imageSvg(commander, score, found))).png().toBuffer()
  res.setHeader('Content-Type', 'image/png')
  // Missing and expired links deliberately receive a short-lived generic image
  // instead of a cacheable record-specific preview.
  res.setHeader('Cache-Control', found ? 'public, max-age=300, s-maxage=3600' : 'public, max-age=60, s-maxage=60')
  res.status(found ? 200 : 404).send(png)
}
