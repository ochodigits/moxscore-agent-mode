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

export function ScoreBoard({
  analysis,
  previousOverall,
}: {
  analysis: AgentAnalysis
  previousOverall: number | null
}) {
  const tone = scoreTone(analysis.overall)
  const weak = new Set(analysis.weaknesses.map((w) => w.category))

  return (
    <section className="agent-scoreboard" aria-label="Health dashboard">
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
    </section>
  )
}
