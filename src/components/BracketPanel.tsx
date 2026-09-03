import type { BracketResult, FlaggedCard } from '../lib/bracketEngine'
import type { LocalCard } from '../lib/cardDatabase'
import { useI18n } from '../lib/i18n'

const BRACKET_COLORS: Record<number, string> = {
  2: '#3fb950',
  3: '#d29922',
  4: '#f0883e',
  5: '#f85149',
}

const REASON_LABELS: Record<FlaggedCard['reason'], string> = {
  gameChanger: 'Game Changer',
  massLandDenial: 'Mass land denial',
  extraTurn: 'Extra turns',
  earlyCombo: 'Early combo',
  lateCombo: 'Combo',
  fastMana: 'Fast mana',
  tutor: 'Tutor',
}

interface BracketPanelProps {
  bracket: BracketResult
  onHover: (card: LocalCard, x: number, y: number) => void
  onLeave: () => void
}

/** Minimal LocalCard so the shared Scryfall hover preview works by name. */
const hoverCard = (name: string): LocalCard => ({ name, cmc: 0, cost: '', type: '', cats: [], note: '', qty: 1 })

export function BracketPanel({ bracket, onHover, onLeave }: BracketPanelProps) {
  const { t } = useI18n()
  const color = BRACKET_COLORS[bracket.bracket] ?? '#3fb950'
  const powerPct = ((bracket.powerScore - 1) / 9) * 100

  return (
    <div className="mox-bracket">
      <div className="mox-bracket-head">
        <div className="mox-bracket-badge" style={{ borderColor: color, color }}>
          <span className="t-eyebrow">Beta estimate</span>
          <span className="mox-bracket-num">{bracket.bracket}</span>
          <span className="mox-bracket-name">{bracket.bracketName}</span>
        </div>
        <div className="mox-bracket-power">
          <div className="mox-bracket-power-label">
            <span>{t('bracket.power')}</span>
            <strong>{bracket.powerScore.toFixed(1)} / 10</strong>
          </div>
          <div className="mox-bracket-power-track">
            <div className="mox-bracket-power-fill" style={{ width: `${powerPct}%`, background: color }} />
          </div>
        </div>
      </div>

      {bracket.hardFlags.length > 0 && (
        <ul className="mox-bracket-flags">
          {bracket.hardFlags.map((f) => (
            <li key={f.code}>{f.message}</li>
          ))}
        </ul>
      )}
      {bracket.comboCheck === 'failed' && <p className="mox-bracket-note">{t('bracket.comboFailed')}</p>}

      <div className="mox-bracket-cards">
        <div className="mox-block-head" style={{ marginBottom: 8 }}>
          <h3>{t('bracket.flagged')}</h3>
          <p>{t('bracket.flaggedSub')}</p>
        </div>
        {bracket.flaggedCards.length === 0 ? (
          <p className="mox-bracket-note">{t('bracket.noFlags')}</p>
        ) : (
          <ul className="mox-bracket-flaglist">
            {bracket.flaggedCards.map((f, i) => (
              <li key={`${f.card}-${f.reason}-${i}`}>
                <span
                  className="mox-bracket-cardname"
                  onMouseMove={(e) => onHover(hoverCard(f.card), e.clientX, e.clientY)}
                  onMouseLeave={onLeave}
                >
                  {f.card}
                </span>
                <span className="mox-bracket-reason">{REASON_LABELS[f.reason]}</span>
                <span className="mox-bracket-impact" title="Bracket impact">
                  {'▮'.repeat(f.bracketImpact)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mox-bracket-note">
        {t('bracket.b1note')} · {t('bracket.listVersion')}: {bracket.gameChangersListVersion}
      </p>
    </div>
  )
}
