import { useState } from 'react'
import type { LocalCard } from '../lib/cardDatabase'
import { useCardPreview } from '../hooks/useCardPreview'
import type { PendingProposals } from '../state/deckStore.ts'

/** Minimal card shell for the Scryfall hover preview — the image is fetched by name. */
function hoverCard(name: string): LocalCard {
  return { name, cmc: 0, cost: '', type: '', cats: [], note: '', qty: 1 }
}

function ProposalCardName({
  name,
  onHover,
  onLeave,
}: {
  name: string
  onHover: (card: LocalCard, x: number, y: number) => void
  onLeave: () => void
}) {
  const move = (e: React.MouseEvent) => onHover(hoverCard(name), e.clientX, e.clientY)
  return (
    <strong onMouseEnter={move} onMouseMove={move} onMouseLeave={onLeave}>
      {name}
    </strong>
  )
}

export function ProposalPanel({
  proposals,
  busy,
  onAcceptAll,
  onAcceptSelected,
  onReject,
}: {
  proposals: PendingProposals | null
  busy: boolean
  onAcceptAll: () => void
  onAcceptSelected: (cuts: string[], adds: string[]) => void
  onReject: () => void
}) {
  const { onHover, onLeave, previewNode } = useCardPreview()
  const [selectedCuts, setSelectedCuts] = useState(() => proposals?.cuts.map((c) => c.name) ?? [])
  const [selectedAdds, setSelectedAdds] = useState(() => proposals?.adds.map((a) => a.name) ?? [])

  if (!proposals) {
    return (
      <section className="agent-proposals" aria-label="Proposed changes">
        <div className="t-eyebrow">Proposed changes</div>
        <p className="agent-muted">No pending proposals. Call propose_changes or use the button after analyzing.</p>
      </section>
    )
  }

  const pending = proposals.status === 'pending'
  const toggle = (name: string, list: string[], setList: (next: string[]) => void) => {
    setList(list.includes(name) ? list.filter((n) => n !== name) : [...list, name])
  }

  return (
    <section className="agent-proposals" aria-label="Proposed changes">
      <div className="agent-proposals-head">
        <div className="t-eyebrow">Proposed changes</div>
        <span className={`agent-pill ${proposals.status}`}>{proposals.status}</span>
      </div>
      <p className="agent-muted">
        Weakest: {proposals.weakest.join(', ') || 'n/a'}. {proposals.note}
      </p>
      <div className="agent-proposal-grid">
        <div>
          <h3>Cuts</h3>
          {proposals.cuts.length === 0 && <p className="agent-muted">None</p>}
          {proposals.cuts.map((cut) => (
            <label key={cut.name} className="agent-proposal-row">
              <input
                type="checkbox"
                disabled={!pending}
                checked={selectedCuts.includes(cut.name)}
                onChange={() => toggle(cut.name, selectedCuts, setSelectedCuts)}
              />
              <span>
                <ProposalCardName name={cut.name} onHover={onHover} onLeave={onLeave} />
                <em>{cut.helps}</em>
                <small>{cut.reason}</small>
              </span>
            </label>
          ))}
        </div>
        <div>
          <h3>Adds</h3>
          {proposals.adds.length === 0 && <p className="agent-muted">None</p>}
          {proposals.adds.map((add) => (
            <label key={add.name} className="agent-proposal-row">
              <input
                type="checkbox"
                disabled={!pending}
                checked={selectedAdds.includes(add.name)}
                onChange={() => toggle(add.name, selectedAdds, setSelectedAdds)}
              />
              <span>
                <ProposalCardName name={add.name} onHover={onHover} onLeave={onLeave} />
                <em>{add.helps}</em>
                <small>{add.reason}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      {previewNode}
      {pending && (
        <div className="agent-proposal-actions">
          <button type="button" className="mox-primarybtn" disabled={busy} onClick={onAcceptAll}>
            Accept all
          </button>
          <button
            type="button"
            className="mox-ghostbtn"
            disabled={busy || (selectedCuts.length === 0 && selectedAdds.length === 0)}
            onClick={() => onAcceptSelected(selectedCuts, selectedAdds)}
          >
            Accept selected
          </button>
          <button type="button" className="mox-ghostbtn" disabled={busy} onClick={onReject}>
            Reject
          </button>
        </div>
      )}
    </section>
  )
}
