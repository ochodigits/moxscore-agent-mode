import { useState } from 'react'
import { fetchAiSuggestions, type AiSwap } from '../lib/aiSuggest'
import type { AnalysisResult } from '../lib/localEngine'
import type { MtgFormat } from '../lib/formats'
import type { LocalCard } from '../lib/cardDatabase'
import { useI18n, type TranslationKey } from '../lib/i18n'

interface AiSuggestionsProps {
  decklist: string
  result: AnalysisResult
  format: MtgFormat
  onAdd: (name: string) => void
  onRemove: (name: string) => void
  onApplySwap: (add: string, cut?: string) => void
  onHover: (card: LocalCard, x: number, y: number) => void
  onLeave: () => void
}

// Minimal card shell for the Scryfall hover preview — the image is fetched by name.
function hoverCard(name: string): LocalCard {
  return { name, cmc: 0, cost: '', type: '', cats: [], note: '', qty: 1 }
}

/** Group swaps by their (model-provided) category so related ideas sit together. */
function groupByCategory(swaps: AiSwap[]): [string, AiSwap[]][] {
  const groups = new Map<string, AiSwap[]>()
  for (const s of swaps) {
    const key = s.category.trim().toLowerCase() || 'general'
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }
  return [...groups.entries()]
}

// Model-provided categories are English free text; map the common ones onto
// the shared category translations, fall back to capitalized raw text.
const AI_CAT_KEYS: Record<string, TranslationKey> = {
  'ramp': 'cat.ramp',
  'draw': 'cat.draw',
  'card draw': 'cat.draw',
  'interaction': 'cat.interaction',
  'removal': 'cat.interaction',
  'wipes': 'cat.wipes',
  'board wipes': 'cat.wipes',
  'protection': 'cat.protection',
  'curve': 'cat.curve',
  'mana curve': 'cat.curve',
  'lands': 'cat.lands',
  'mana base': 'cat.lands',
  'wincons': 'cat.wincons',
  'win conditions': 'cat.wincons',
}

function fallbackLabel(key: string): string {
  return key.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function AiSuggestions({ decklist, result, format, onAdd, onRemove, onApplySwap, onHover, onLeave }: AiSuggestionsProps) {
  const { t } = useI18n()
  const [swaps, setSwaps] = useState<AiSwap[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aggressive, setAggressive] = useState(false)
  const [applied, setApplied] = useState<Set<string>>(new Set())

  async function generate() {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      setSwaps(await fetchAiSuggestions(decklist, result, format, { aggressive }))
      setApplied(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI suggestions are unavailable right now.')
    } finally {
      setLoading(false)
    }
  }

  function applySwap(s: AiSwap, key: string) {
    onApplySwap(s.add, s.cut)
    setApplied((prev) => new Set(prev).add(key))
  }

  return (
    <div className="mox-ai-suggest">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button type="button" className="mox-primarybtn" onClick={() => void generate()} disabled={loading}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3L10 7.5 6.5 9 5 12 3.5 9 0 7.5 3.5 6 5 3zM19 8l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2zM12 13l1.5 3 3.5 1.5-3.5 1.5L12 22l-1.5-3L7 17.5 10.5 16 12 13z" transform="translate(1 0)" />
          </svg>
          {loading ? t('ai.thinking') : swaps ? t('ai.regenerate') : t('ai.generate')}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-tertiary)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={aggressive}
            onChange={(e) => setAggressive(e.target.checked)}
            disabled={loading}
          />
          {t('ai.bestInSlot')}
        </label>
      </div>

      {error && (
        <div className="mox-share-error" style={{ marginTop: 10 }}>{error}</div>
      )}

      {swaps && swaps.length > 0 && (
        <div style={{ marginTop: 16, display: 'grid', gap: 18, textAlign: 'left' }}>
          {groupByCategory(swaps).map(([cat, items]) => (
            <div key={cat}>
              <div className="t-eyebrow" style={{ fontSize: 11, marginBottom: 8 }}>{AI_CAT_KEYS[cat] ? t(AI_CAT_KEYS[cat]) : fallbackLabel(cat)}</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {items.map((s, i) => {
                  const key = `${cat}:${s.add}:${s.cut ?? ''}:${i}`
                  const isApplied = applied.has(key)
                  return (
                    <div
                      key={key}
                      style={{
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 10,
                        padding: '12px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        opacity: isApplied ? 0.6 : 1,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="mox-inlinebtn"
                          onClick={() => onAdd(s.add)}
                          onMouseMove={(e) => onHover(hoverCard(s.add), e.clientX, e.clientY)}
                          onMouseLeave={onLeave}
                          title={`Add ${s.add} in the deck editor`}
                        >
                          + {s.add}
                        </button>
                        {s.cut && (
                          <>
                            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{t('ai.for')}</span>
                            <button
                              type="button"
                              className="mox-inlinebtn"
                              onClick={() => onRemove(s.cut!)}
                              onMouseMove={(e) => onHover(hoverCard(s.cut!), e.clientX, e.clientY)}
                              onMouseLeave={onLeave}
                              title={`Remove ${s.cut} from the deck`}
                            >
                              − {s.cut}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="mox-chip"
                          style={{ marginLeft: 'auto' }}
                          disabled={isApplied}
                          onClick={() => applySwap(s, key)}
                          title={s.cut ? `Swap ${s.cut} for ${s.add} and rescore` : `Add ${s.add} and rescore`}
                        >
                          {isApplied ? t('ai.applied') : t('ai.apply')}
                        </button>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{s.reason}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
