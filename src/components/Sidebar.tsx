import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { ManaCost } from './ManaCost'
import { MOX_DB, getAllCardNames } from '../lib/cardDatabase'
import type { LocalCard } from '../lib/cardDatabase'
import { useCardPreview } from '../hooks/useCardPreview'
import { useI18n, type TranslationKey } from '../lib/i18n'

// Sidebar rows are grouped by each card's primary category so a specific kind
// of card is easy to find. First matching cat in this order wins.
const GROUP_ORDER: { key: string; label: TranslationKey; cats: string[] }[] = [
  { key: 'lands', label: 'cat.lands', cats: ['land'] },
  { key: 'ramp', label: 'cat.ramp', cats: ['ramp'] },
  { key: 'draw', label: 'cat.draw', cats: ['draw'] },
  { key: 'interaction', label: 'cat.interaction', cats: ['removal', 'counter'] },
  { key: 'wipes', label: 'cat.wipes', cats: ['wipe'] },
  { key: 'protection', label: 'cat.protection', cats: ['protection'] },
  { key: 'wincons', label: 'cat.wincons', cats: ['wincon'] },
  { key: 'creatures', label: 'cat.creatures', cats: ['creature'] },
  { key: 'other', label: 'cat.other', cats: [] },
]

function groupKeyFor(cats: string[] | undefined): string {
  if (cats?.length) {
    for (const g of GROUP_ORDER) {
      if (g.cats.some((c) => cats.includes(c))) return g.key
    }
  }
  return 'other'
}

interface SidebarProps {
  open: boolean
  onToggle: () => void
  onClose: () => void
  entries: LocalCard[]
  onRerun: (text: string) => void
  addQueue?: { name: string; ts: number } | null
  deckLimit?: number
}

export function Sidebar({ open, onToggle, onClose, entries, onRerun, addQueue, deckLimit = 100 }: SidebarProps) {
  const { t } = useI18n()
  const { onHover, onLeave, previewNode } = useCardPreview()
  const [tab, setTab] = useState<'list' | 'text'>('list')
  const [rows, setRows] = useState(() => entries.map((e) => ({ name: e.name, qty: e.qty })))
  const [text, setText] = useState('')
  const [addQ, setAddQ] = useState('')
  const [dirty, setDirty] = useState(false)

  const sig = entries.map((e) => `${e.name}:${e.qty}`).join('|')
  const lastSig = useRef(sig)
  useEffect(() => {
    if (sig !== lastSig.current) {
      lastSig.current = sig
      setRows(entries.map((e) => ({ name: e.name, qty: e.qty })))
      setDirty(false)
    }
  }, [sig, entries])

  useEffect(() => {
    if (!addQueue) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setRows((rs) => {
        const current = rs.reduce((s, r) => s + r.qty, 0)
        const ex = rs.find((r) => r.name === addQueue.name)
        if (ex) {
          if (current >= deckLimit) return rs
          return rs.map((r) => r.name === addQueue.name ? { ...r, qty: r.qty + 1 } : r)
        }
        if (current >= deckLimit) return rs
        return [...rs, { name: addQueue.name, qty: 1 }]
      })
      setDirty(true)
    })
    return () => { cancelled = true }
  }, [addQueue, deckLimit])

  const toText = (rs: { name: string; qty: number }[]) => rs.map((r) => `${r.qty} ${r.name}`).join('\n')

  function bump(name: string, delta: number) {
    setRows((rs) => {
      const current = rs.reduce((s, r) => s + r.qty, 0)
      if (delta > 0 && current >= deckLimit) return rs
      return rs.map((r) => r.name === name ? { ...r, qty: Math.max(0, r.qty + delta) } : r).filter((r) => r.qty > 0)
    })
    setDirty(true)
  }

  function addCard(name: string) {
    // Prefer the local DB's canonical casing, but accept ANY card name — the
    // analysis engine resolves unknown names through Scryfall on rerun.
    const canonical =
      getAllCardNames().find((k) => k.toLowerCase() === name.trim().toLowerCase()) ?? name.trim()
    if (!canonical) return
    setRows((rs) => {
      const current = rs.reduce((s, r) => s + r.qty, 0)
      const ex = rs.find((r) => r.name === canonical)
      if (ex) {
        if (current >= deckLimit) return rs
        return rs.map((r) => r.name === canonical ? { ...r, qty: r.qty + 1 } : r)
      }
      if (current >= deckLimit) return rs
      return [...rs, { name: canonical, qty: 1 }]
    })
    setAddQ('')
    setDirty(true)
  }

  function rerun() {
    const src = tab === 'text' && text.trim() ? text : toText(rows)
    onRerun(src)
    setDirty(false)
  }

  // Scryfall autocomplete so "Add a card" works for ANY card, not just the
  // small built-in database. Debounced; local DB matches are shown instantly.
  const [scryMatches, setScryMatches] = useState<string[]>([])
  useEffect(() => {
    const q = addQ.trim()
    const timer = setTimeout(() => {
      if (q.length < 2) {
        setScryMatches([])
        return
      }
      fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((d: { data?: string[] }) => setScryMatches(d.data ?? []))
        .catch(() => setScryMatches([]))
    }, q.length < 2 ? 0 : 250)
    return () => clearTimeout(timer)
  }, [addQ])

  const matches = useMemo(() => {
    if (!addQ.trim()) return []
    const q = addQ.toLowerCase()
    const local = getAllCardNames().filter((n) => n.toLowerCase().includes(q))
    const merged = [...new Set([...local, ...scryMatches])]
    return merged.filter((n) => !rows.some((r) => r.name === n)).slice(0, 8)
  }, [addQ, scryMatches, rows])

  // Prefer Scryfall-sourced data from entries; fall back to the local static DB.
  const entryMap = useMemo(
    () => new Map(entries.map((e) => [e.name, e])),
    [entries]
  )

  const totalCards = rows.reduce((s, r) => s + r.qty, 0)
  const sidebarRef = useRef<HTMLElement>(null)

  const handleOutsideClick = useCallback((e: MouseEvent) => {
    if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    if (!open) return
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open, handleOutsideClick])

  return (
    <aside ref={sidebarRef} className={`mox-sidebar ${open ? 'open' : 'closed'}`}>
      {previewNode}
      <button type="button" className="mox-sidebar-handle" onClick={onToggle} title={open ? 'Collapse' : 'Edit deck'}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
          {open
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M3 4h18M3 12h18M3 20h4" />
          }
        </svg>
      </button>

      {open && (
        <div className="mox-sidebar-inner">
          <div className="mox-sidebar-head">
            <h3>{t('sidebar.edit')}</h3>
            <span className={`mox-sidebar-count${totalCards >= deckLimit ? ' at-limit' : ''}`}>
              {totalCards} / {deckLimit}
            </span>
          </div>
          {totalCards >= deckLimit && (
            <div className="mox-sidebar-limit-warn">
              {t('sidebar.limitWarn')}
            </div>
          )}
          <div className="mox-tabs">
            <button type="button" className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>{t('sidebar.list')}</button>
            <button type="button" className={tab === 'text' ? 'active' : ''} onClick={() => { setTab('text'); setText(toText(rows)) }}>{t('sidebar.text')}</button>
          </div>

          {tab === 'list' ? (
            <div className="mox-sidebar-body">
              <div className="mox-addrow">
                <input
                  className="mox-addinput"
                  placeholder={totalCards >= deckLimit ? t('sidebar.limitReached') : t('sidebar.addPlaceholder')}
                  value={addQ}
                  disabled={totalCards >= deckLimit}
                  onChange={(e) => setAddQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addCard(matches[0] ?? addQ) }}
                />
                {matches.length > 0 && (
                  <div className="mox-addmenu">
                    {matches.map((n) => <button key={n} type="button" onClick={() => addCard(n)}>{n}</button>)}
                  </div>
                )}
              </div>
              <div className="mox-rows">
                {GROUP_ORDER.map((group) => {
                  const groupRows = rows
                    .filter((r) => groupKeyFor((entryMap.get(r.name) ?? MOX_DB[r.name])?.cats) === group.key)
                    .sort((a, b) => a.name.localeCompare(b.name))
                  if (groupRows.length === 0) return null
                  const groupQty = groupRows.reduce((s, r) => s + r.qty, 0)
                  return (
                    <div key={group.key} className="mox-row-group">
                      <div className="mox-row-group-head">
                        <span>{t(group.label)}</span>
                        <span className="mox-row-group-count">{groupQty}</span>
                      </div>
                      {groupRows.map((r) => {
                        const card = entryMap.get(r.name) ?? MOX_DB[r.name]
                        const hoverCard: LocalCard = {
                          name: r.name, qty: r.qty,
                          cmc: card?.cmc ?? 0, cost: card?.cost ?? '',
                          type: card?.type ?? '', cats: card?.cats ?? [], note: card?.note ?? '',
                        }
                        return (
                          <div
                            key={r.name}
                            className="mox-row"
                            onMouseMove={(e) => onHover(hoverCard, e.clientX, e.clientY)}
                            onMouseLeave={onLeave}
                          >
                            <span className="mox-row-name" title={r.name}>{r.name}</span>
                            {card?.cost && <ManaCost cost={card.cost} scale={0.66} />}
                            <div className="mox-stepper">
                              <button type="button" onClick={() => bump(r.name, -1)}>−</button>
                              <span>{r.qty}</span>
                              <button type="button" onClick={() => bump(r.name, 1)} disabled={totalCards >= deckLimit}>+</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="mox-sidebar-body">
              <textarea
                className="mox-textarea"
                value={text}
                onChange={(e) => { setText(e.target.value); setDirty(true) }}
                spellCheck={false}
              />
            </div>
          )}

          <div className="mox-sidebar-foot">
            <button type="button" className={`mox-rerun ${dirty ? 'dirty' : ''}`} onClick={rerun}>
              {dirty ? t('sidebar.rerun') : t('sidebar.upToDate')}
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
