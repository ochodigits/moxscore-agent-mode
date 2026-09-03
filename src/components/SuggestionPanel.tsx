import type { Suggestion } from '../lib/localEngine'
import type { LocalCard } from '../lib/cardDatabase'
import { useI18n } from '../lib/i18n'

interface SuggestionPanelProps {
  suggestions: Suggestion[]
  onAdd?: (name: string) => void
  onRemove?: (name: string) => void
  onHover?: (card: LocalCard, x: number, y: number) => void
  onLeave?: () => void
}

// Minimal card shell for the Scryfall hover preview — the image is fetched by name.
function hoverCard(name: string): LocalCard {
  return { name, cmc: 0, cost: '', type: '', cats: [], note: '', qty: 1 }
}

export function SuggestionPanel({ suggestions, onAdd, onRemove, onHover, onLeave }: SuggestionPanelProps) {
  const { t } = useI18n()
  if (!suggestions.length) {
    return <div className="mox-suggest-empty">{t('suggest.empty')}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {suggestions.map((s, i) => {
        const pct = Math.round(s.impact)
        const hasCuts = s.cutCandidates && s.cutCandidates.length > 0
        return (
          <div key={s.key} className="mox-suggest">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mox-suggest-rank">{i + 1}</span>
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>{s.title}</span>
              {pct > 0 && pct < 999 && <span className="mox-suggest-impact">+{pct} pts</span>}
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '8px 0 0' }}>{s.body}</p>

            {s.examples.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {s.examples.slice(0, 4).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="mox-chip"
                    onClick={() => onAdd?.(name)}
                    onMouseMove={(e) => onHover?.(hoverCard(name), e.clientX, e.clientY)}
                    onMouseLeave={onLeave}
                  >
                    <span style={{ fontSize: 13, lineHeight: 1 }}>+</span> {name}
                  </button>
                ))}
              </div>
            )}

            {hasCuts && (
              <div style={{ marginTop: s.examples.length > 0 ? 8 : 10 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                  {t('suggest.considerCutting')}
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {s.cutCandidates!.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="mox-chip mox-chip--cut"
                      onClick={() => onRemove?.(name)}
                      onMouseMove={(e) => onHover?.(hoverCard(name), e.clientX, e.clientY)}
                      onMouseLeave={onLeave}
                    >
                      <span style={{ fontSize: 13, lineHeight: 1 }}>−</span> {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
