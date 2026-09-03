import type { CSSProperties, Ref } from 'react'
import { formatScore } from '../lib/formatScore.ts'
import { scoreTone } from '../lib/scoreTone.ts'
import type { AgentAnalysis, AgentCategory } from '../engine/types.ts'

const LABELS: Record<AgentCategory, string> = {
  ramp: 'Ramp',
  draw: 'Draw',
  interaction: 'Interaction',
  curve: 'Curve',
  wincons: 'Wincons',
}

const ORDER: AgentCategory[] = ['ramp', 'draw', 'interaction', 'curve', 'wincons']

const FAN = [
  { '--fan-x': 'calc(-50% - 28px)', '--fan-y': 'calc(-50% + 6px)', '--fan-r': '-18deg', animationDelay: '0ms', zIndex: 1 },
  { '--fan-x': '-50%', '--fan-y': 'calc(-50% - 8px)', '--fan-r': '0deg', animationDelay: '-600ms', zIndex: 2 },
  { '--fan-x': 'calc(-50% + 28px)', '--fan-y': 'calc(-50% + 6px)', '--fan-r': '18deg', animationDelay: '-1200ms', zIndex: 1 },
]

function ScoreBoardLoading({ compact }: { compact: boolean }) {
  return (
    <div className="agent-score-loading" role="status" aria-live="polite">
      <div className="mox-shuffle-stage agent-score-shuffle" aria-hidden="true">
        {FAN.map((style, i) => (
          <div key={i} className="mox-shuffle-card" style={style as CSSProperties} />
        ))}
      </div>
      <p className="agent-score-loading-msg">Scoring deck…</p>
      {!compact && (
        <ul className="agent-score-skel" aria-hidden="true">
          <li />
          <li />
          <li />
          <li />
          <li />
        </ul>
      )}
    </div>
  )
}

export function ScoreBoard({
  analysis,
  previousOverall,
  loading = false,
  ref,
}: {
  analysis: AgentAnalysis | null
  previousOverall: number | null
  loading?: boolean
  ref?: Ref<HTMLElement>
}) {
  const classes = [
    'agent-scoreboard',
    loading ? 'is-loading' : '',
    analysis ? 'has-analysis' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      ref={ref}
      id="agent-scoreboard"
      className={classes}
      aria-label="Health dashboard"
      aria-busy={loading || undefined}
    >
      {loading && <ScoreBoardLoading compact={analysis !== null} />}

      {analysis ? (
        <ScoreBoardBody analysis={analysis} previousOverall={previousOverall} />
      ) : (
        !loading && (
          <>
            <div className="t-eyebrow">Health dashboard</div>
            <p className="agent-muted">
              Run Analyze (or call analyze_deck) to score this list. Sample deck is prefilled.
            </p>
          </>
        )
      )}
    </section>
  )
}

function ScoreBoardBody({
  analysis,
  previousOverall,
}: {
  analysis: AgentAnalysis
  previousOverall: number | null
}) {
  const tone = scoreTone(analysis.overall)
  const weak = new Set(analysis.weaknesses.map((w) => w.category))

  return (
    <div className="agent-score-content">
      <div className="agent-score-hero">
        <div className="t-eyebrow">Deck health</div>
        <div className="agent-score-number" style={{ color: tone.color }}>
          {formatScore(analysis.overall)}
        </div>
        <div className="agent-score-outof">out of 100</div>
        {previousOverall !== null && (
          <p className="agent-score-delta">
            Previous {formatScore(previousOverall)} → current {formatScore(analysis.overall)}
            <span className={analysis.overall - previousOverall >= 0 ? 'up' : 'down'}>
              {analysis.overall - previousOverall >= 0 ? ' +' : ' '}
              {formatScore(analysis.overall - previousOverall)}
            </span>
          </p>
        )}
      </div>

      <ul className="agent-cat-list">
        {ORDER.map((key) => {
          const value = analysis.categories[key]
          const barTone = scoreTone(value)
          const isWeak = weak.has(key)
          return (
            <li key={key} className={isWeak ? 'weak' : undefined}>
              <div className="agent-cat-head">
                <span>{LABELS[key]}</span>
                <strong style={{ color: barTone.color }}>{formatScore(value)}</strong>
              </div>
              <div className="agent-cat-track">
                <div
                  className="agent-cat-fill"
                  style={{ width: `${value}%`, background: barTone.color }}
                />
              </div>
            </li>
          )
        })}
      </ul>

      <div className="agent-diagnosis">
        <div className="t-eyebrow">Diagnosis</div>
        <ul>
          {analysis.diagnosis.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
