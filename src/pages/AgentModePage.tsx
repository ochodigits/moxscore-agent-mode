import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { MoxLogo } from '../components/Logo'
import { ThemeToggle } from '../components/ThemeToggle'
import { ScoreBoard } from '../ui/ScoreBoard'
import { ProposalPanel } from '../ui/ProposalPanel'
import { AgentLog } from '../ui/AgentLog'
import { scrollToProposalsIfCompact } from '../ui/scrollToProposals.ts'
import { deckMeta } from '../engine/parse.ts'
import { registerAgentTools } from '../webmcp/registerTools.ts'
import {
  analyzeDeck,
  applyChanges,
  proposeChanges,
  rejectProposals,
  resetDemo,
  setDecklist,
  useDeckStore,
} from '../state/deckStore.ts'

interface AgentModePageProps {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}

export default function AgentModePage({ theme, onToggleTheme }: AgentModePageProps) {
  const state = useDeckStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const proposalsRef = useRef<HTMLDivElement>(null)
  const scoreboardRef = useRef<HTMLElement>(null)
  const scrollToProposals = useRef(false)
  const [webmcp, setWebmcp] = useState('WebMCP: checking')
  const meta = deckMeta(state.decklist)

  useEffect(() => {
    if (!scrollToProposals.current || !state.proposals) return
    scrollToProposals.current = false
    scrollToProposalsIfCompact(proposalsRef.current)
  }, [state.proposals])

  useEffect(() => {
    const controller = new AbortController()
    void registerAgentTools(controller.signal)
      .then((result) => {
        setWebmcp(result.ok ? `WebMCP: ${result.via}` : 'WebMCP: unavailable in this browser')
      })
      .catch((err: unknown) => {
        setWebmcp(err instanceof Error ? `WebMCP: ${err.message}` : 'WebMCP: registration failed')
      })
    return () => controller.abort()
  }, [])

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    void file.text().then((text) => setDecklist(text))
  }

  return (
    <div className="mox-landing agent-page">
      <div className="mox-glow-violet" />
      <div className="mox-glow-blue" />

      <header className="mox-landing-head">
        <MoxLogo size={28} />
        <nav className="mox-landing-nav">
          <span className="agent-mode-badge">Agent Mode</span>
        </nav>
        <div className="agent-head-actions">
          <button type="button" className="mox-ghostbtn" onClick={() => resetDemo()}>
            Reset demo
          </button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>

      <main className="agent-layout">
        <section className="agent-workspace">
          <div className="t-eyebrow">Deck workspace</div>
          <h1 className="agent-title">
            MoxScore <span className="t-gradient">Agent Mode</span>
          </h1>
          <p className="agent-lead">
            A human stays in control of a Commander deck while an agent inspects, diagnoses, and applies approved edits through WebMCP. The page is the source of truth.
          </p>

          <div className="mox-drop">
            <textarea
              className="mox-decktext agent-decktext"
              value={state.decklist}
              onChange={(event) => setDecklist(event.target.value)}
              spellCheck={false}
              aria-label="Commander decklist"
            />
            <div className="mox-drop-foot">
              <div className="mox-drop-actions">
                <button type="button" className="mox-ghostbtn" onClick={() => fileRef.current?.click()}>
                  Upload .txt
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt"
                  style={{ display: 'none' }}
                  onChange={onFileChange}
                />
                <button
                  type="button"
                  className="mox-ghostbtn"
                  disabled={state.busy || !state.decklist.trim()}
                  onClick={() => {
                    scrollToProposals.current = true
                    void proposeChanges().then((result) => {
                      if (result && 'error' in result) scrollToProposals.current = false
                    })
                  }}
                >
                  Propose changes
                </button>
              </div>
              <button
                type="button"
                className="mox-primarybtn"
                disabled={state.busy || !state.decklist.trim()}
                onClick={() => {
                  void analyzeDeck()
                  scrollToProposalsIfCompact(scoreboardRef.current)
                }}
              >
                {state.busy ? 'Working…' : 'Analyze'}
              </button>
            </div>
          </div>

          <p className="agent-meta">
            Commander: <strong>{meta.commander}</strong>
            {' · '}
            {meta.card_count} cards
            {state.analysis && state.analysis.unresolved.length > 0 && (
              <>
                {' · '}Unresolved: {state.analysis.unresolved.join(', ')}
              </>
            )}
          </p>
          {state.error && <p className="agent-error">{state.error}</p>}
        </section>

        <aside className="agent-side">
          <ScoreBoard
            ref={scoreboardRef}
            analysis={state.analysis}
            previousOverall={state.previous?.overall ?? null}
            loading={state.busy}
          />
          <div id="agent-proposals" ref={proposalsRef}>
            <ProposalPanel
              key={`${state.proposals?.status ?? 'none'}:${state.proposals?.cuts.map((c) => c.name).join('|')}:${state.proposals?.adds.map((a) => a.name).join('|')}`}
              proposals={state.proposals}
              busy={state.busy}
              onAcceptAll={() => {
                if (!state.proposals) return
                void applyChanges({
                  cuts: state.proposals.cuts.map((c) => c.name),
                  adds: state.proposals.adds.map((a) => a.name),
                  confirm: true,
                })
              }}
              onAcceptSelected={(cuts, adds) => {
                void applyChanges({ cuts, adds, confirm: true })
              }}
              onReject={() => rejectProposals()}
            />
          </div>
          <AgentLog log={state.log} lastAction={state.lastAction} webmcp={webmcp} />
        </aside>
      </main>
    </div>
  )
}
