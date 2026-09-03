import { useState } from 'react'
import { CardRow } from './CardRow'
import { scoreTone } from '../lib/scoreTone'
import type { LocalCard } from '../lib/cardDatabase'
import { useI18n, type TranslationKey } from '../lib/i18n'

const CAT_META: Record<string, { label: TranslationKey; desc: TranslationKey }> = {
  ramp: { label: 'cat.ramp', desc: 'catdesc.ramp' },
  draw: { label: 'cat.draw', desc: 'catdesc.draw' },
  interaction: { label: 'cat.interaction', desc: 'catdesc.interaction' },
  wipes: { label: 'cat.wipes', desc: 'catdesc.wipes' },
  protection: { label: 'cat.protection', desc: 'catdesc.protection' },
  curve: { label: 'cat.curve', desc: 'catdesc.curve' },
  lands: { label: 'cat.lands', desc: 'catdesc.lands' },
  wincons: { label: 'cat.wincons', desc: 'catdesc.wincons' },
}

interface CategoryCardProps {
  catKey: string
  score: number
  feedback: string
  metric: string
  cards: LocalCard[]
  onHover: (card: LocalCard, x: number, y: number) => void
  onLeave: () => void
  hint?: string
}

export function CategoryCard({ catKey, score, feedback, metric, cards, onHover, onLeave, hint }: CategoryCardProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const keys = CAT_META[catKey]
  const meta = keys ? { label: t(keys.label), desc: t(keys.desc) } : { label: catKey, desc: '' }
  const tone = scoreTone(score)

  return (
    <div className="mox-cat">
      <div style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <span className="t-eyebrow" style={{ color: 'var(--text-tertiary)' }}>{meta.label}</span>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, lineHeight: 1, color: tone.color }}>{Math.round(score)}</span>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '10px 0 0' }}>{meta.desc}</p>
        <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '14px 0 0', paddingTop: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{feedback}</p>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', margin: '6px 0 0' }}>{metric}</p>
        </div>
        {hint && (
          <div className="mox-hint">
            <span className="mox-hint-dot" style={{ background: tone.color }} />
            <span>{hint}</span>
          </div>
        )}
      </div>
      <button
        type="button"
        className="mox-cat-toggle"
        disabled={cards.length === 0}
        onClick={() => cards.length > 0 && setOpen((o) => !o)}
      >
        <span>{cards.length === 0 ? 'No cards detected' : open ? 'Hide cards' : `Show ${cards.length} card${cards.length === 1 ? '' : 's'}`}</span>
        {cards.length > 0 && (
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
            style={{ transition: 'transform 150ms', transform: open ? 'rotate(180deg)' : 'none' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
      {open && cards.length > 0 && (
        <div className="mox-cat-list">
          {cards.map((c) => <CardRow key={c.name} card={c} onHover={onHover} onLeave={onLeave} />)}
        </div>
      )}
    </div>
  )
}
