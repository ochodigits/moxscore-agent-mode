import { ManaCost } from './ManaCost'
import type { LocalCard } from '../lib/cardDatabase'

interface CardRowProps {
  card: LocalCard
  onHover: (card: LocalCard, x: number, y: number) => void
  onLeave: () => void
}

export function CardRow({ card, onHover, onLeave }: CardRowProps) {
  const move = (e: React.MouseEvent) => onHover(card, e.clientX, e.clientY)
  return (
    <div className="mox-cardrow" onMouseMove={move} onMouseEnter={move} onMouseLeave={onLeave}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="mox-cardrow-name">{card.name}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {card.cost
          ? <ManaCost cost={card.cost} scale={0.78} />
          : <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>land</span>
        }
        {card.qty > 1 && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>×{card.qty}</span>}
      </span>
    </div>
  )
}
