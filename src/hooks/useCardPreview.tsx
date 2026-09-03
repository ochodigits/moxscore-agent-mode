import { useState, useCallback, useEffect, useRef } from 'react'
import type { LocalCard } from '../lib/cardDatabase'
import { useI18n } from '../lib/i18n'
import type { Locale } from '../lib/i18n-config'

interface Preview { card: LocalCard; x: number; y: number }

// Cached per locale so switching language re-fetches localized printings.
const imageCache = new Map<string, string | null>()

function imageFrom(data: {
  image_uris?: { normal?: string }
  card_faces?: Array<{ image_uris?: { normal?: string } }>
}): string | null {
  return data.image_uris?.normal ?? data.card_faces?.[0]?.image_uris?.normal ?? null
}

async function fetchScryfallImage(name: string, locale: Locale): Promise<string | null> {
  const key = `${locale}:${name}`
  if (imageCache.has(key)) return imageCache.get(key)!
  try {
    // Non-English: look up a printing in the selected language first.
    // Scryfall's /cards/named only returns English, so use a prints search.
    if (locale !== 'en') {
      const q = `!"${name}" lang:${locale}`
      const res = await fetch(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`
      )
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<Parameters<typeof imageFrom>[0]> }
        for (const card of data.data ?? []) {
          const uri = imageFrom(card)
          if (uri) {
            imageCache.set(key, uri)
            return uri
          }
        }
      }
      // No localized printing exists — fall through to the English image.
    }
    const res = await fetch(
      `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`
    )
    if (!res.ok) { imageCache.set(key, null); return null }
    const uri = imageFrom(await res.json())
    imageCache.set(key, uri)
    return uri
  } catch {
    imageCache.set(key, null)
    return null
  }
}

export function useCardPreview({ size = 200 }: { size?: number } = {}) {
  const { locale } = useI18n()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const fetchRef = useRef<string | null>(null)

  const onHover = useCallback((card: LocalCard, x: number, y: number) => {
    setPreview({ card, x, y })
  }, [])

  const onLeave = useCallback(() => {
    setPreview(null)
    setImageUrl(null)
  }, [])

  useEffect(() => {
    if (!preview) return
    const name = preview.card.name
    const key = `${locale}:${name}`
    fetchRef.current = key
    let cancelled = false
    if (imageCache.has(key)) {
      queueMicrotask(() => {
        if (!cancelled) setImageUrl(imageCache.get(key) ?? null)
      })
      return () => { cancelled = true }
    }
    queueMicrotask(() => {
      if (!cancelled) setImageUrl(null)
    })
    fetchScryfallImage(name, locale).then((url) => {
      if (!cancelled && fetchRef.current === key) setImageUrl(url)
    })
    return () => { cancelled = true }
  }, [preview, locale])

  const previewNode = preview && imageUrl ? (() => {
    const w = size, h = Math.round(size * 1.395)
    let left = preview.x + 22
    let top = preview.y - Math.round(h * 0.25)
    if (left + w > window.innerWidth - 12) left = preview.x - w - 22
    if (top + h > window.innerHeight - 12) top = window.innerHeight - h - 12
    if (top < 12) top = 12
    return (
      <div style={{ position: 'fixed', left, top, zIndex: 1300, pointerEvents: 'none' }}>
        <img
          src={imageUrl}
          alt={preview.card.name}
          width={w}
          style={{ borderRadius: 12, boxShadow: '0 24px 60px -16px rgba(0,0,0,0.75)', display: 'block' }}
        />
      </div>
    )
  })() : null

  return { onHover, onLeave, previewNode }
}
