import { ManaCost } from './ManaCost'
import type { LocalCard } from '../lib/cardDatabase'

export function CardFace({ card }: { card: LocalCard }) {
  const colorEdge = (() => {
    const cols = (card.cost.match(/[WUBRG]/g) || [])
    if (cols.length === 0) return 'linear-gradient(160deg,#3a3445,#241b3f)'
    if (cols.length > 1) return 'linear-gradient(160deg,#6b5a1f,#3a2f12)'
    const map: Record<string, string> = { W: '#9b8e5e', U: '#264f8c', B: '#2c2833', R: '#8c2f22', G: '#235c34' }
    const c0 = cols[0]
    return `linear-gradient(160deg, ${c0 ? (map[c0] ?? '#3a3445') : '#3a3445'}, #1a1626)`
  })()

  return (
    <div style={{ width: 240, borderRadius: 14, padding: 7, background: colorEdge, boxShadow: '0 24px 60px -16px rgba(0,0,0,0.75)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <div style={{ borderRadius: 9, background: '#15111d', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: '#fff', lineHeight: 1.15 }}>{card.name}</span>
          <ManaCost cost={card.cost} scale={0.85} />
        </div>
        <div style={{ height: 84, margin: '8px 10px 0', borderRadius: 6, background: 'radial-gradient(120% 120% at 30% 20%, rgba(131,62,255,0.5), rgba(39,102,255,0.15) 60%, #100b1b)', border: '1px solid rgba(255,255,255,0.07)' }} />
        <div style={{ padding: '8px 10px 4px', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)' }}>{card.type}</div>
        {card.note && <div style={{ padding: '0 10px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-secondary)' }}>{card.note}</div>}
      </div>
    </div>
  )
}
