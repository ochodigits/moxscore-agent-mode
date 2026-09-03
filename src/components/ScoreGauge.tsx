import { useState, useEffect, useRef } from 'react'
import type { SubScores } from '../lib/localEngine'
import { scoreTone, scoreBand } from '../lib/scoreTone'
import { useI18n, type TranslationKey } from '../lib/i18n'

const CAT_KEYS: Record<string, TranslationKey> = {
  ramp: 'cat.ramp',
  draw: 'cat.draw',
  interaction: 'cat.interaction',
  wipes: 'cat.wipes',
  protection: 'cat.protection',
  curve: 'cat.curve',
  lands: 'cat.lands',
  wincons: 'cat.wincons',
}

function useCountUp(target: number, duration = 1100, run = true) {
  const [val, setVal] = useState(run ? 0 : target)
  const raf = useRef(0)
  useEffect(() => {
    if (!run) {
      queueMicrotask(() => setVal(target))
      return
    }
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(target * eased))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration, run])
  return val
}

interface ScoreGaugeProps {
  score: number
  summary: string
  variant: 'ring' | 'number' | 'bars'
  subScores: SubScores
  animate?: boolean
}

export function ScoreGauge({ score, summary, variant, subScores, animate = true }: ScoreGaugeProps) {
  const { t } = useI18n()
  const v = useCountUp(score, 1100, animate)
  const tone = scoreTone(score)

  const Eyebrow = <div className="t-eyebrow" style={{ marginBottom: 6 }}>{t('gauge.eyebrow')}</div>
  const Summary = <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-body-lg)', maxWidth: 460, margin: '14px auto 0', lineHeight: 1.5 }}>{summary}</p>

  if (variant === 'ring') {
    const R = 92, C = 2 * Math.PI * R
    const dash = C * (v / 100)
    return (
      <div style={{ textAlign: 'center' }}>
        {Eyebrow}
        <div style={{ position: 'relative', width: 220, height: 220, margin: '8px auto 0' }}>
          <svg width={220} height={220} viewBox="0 0 220 220" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={110} cy={110} r={R} fill="none" stroke="rgba(131,62,255,0.16)" strokeWidth={14} />
            <circle cx={110} cy={110} r={R} fill="none" stroke={tone.color} strokeWidth={14} strokeLinecap="round"
              strokeDasharray={`${dash} ${C}`} style={{ transition: 'stroke-dasharray 80ms linear' }} />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 64, lineHeight: 1, color: tone.color }}>{v}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{t('gauge.outOf')}</span>
          </div>
        </div>
        {Summary}
      </div>
    )
  }

  if (variant === 'bars') {
    const order = ['ramp', 'draw', 'interaction', 'wipes', 'protection', 'curve', 'lands', 'wincons'] as const
    return (
      <div style={{ textAlign: 'center' }}>
        {Eyebrow}
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 96, lineHeight: 0.95, color: tone.color }}>{v}</div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>{t('gauge.outOf')}</span>
        <div style={{ marginTop: 10 }}>
          <span
            style={{
              display: 'inline-block',
              padding: '4px 14px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.03em',
              color: tone.color,
              border: `1px solid ${tone.color}`,
              background: 'transparent',
            }}
          >
            {scoreBand(score)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, maxWidth: 420, margin: '18px auto 0' }}>
          {order.map((k) => {
            const key = CAT_KEYS[k]
            const label = key ? t(key) : k
            const barTone = scoreTone(subScores[k])
            return (
              <div key={k} title={label} style={{ flex: '1 1 0', minWidth: 0 }}>
                <div style={{ height: 46, borderRadius: 6, background: 'var(--border-subtle)', display: 'flex', alignItems: 'flex-end', overflow: 'hidden' }}>
                  <div style={{ width: '100%', height: `${subScores[k]}%`, background: barTone.color, transition: 'height 600ms var(--ease-out)' }} />
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-tertiary)', marginTop: 5, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label.split(' ')[0]}
                </div>
              </div>
            )
          })}
        </div>
        {Summary}
      </div>
    )
  }

  return (
    <div style={{ textAlign: 'center' }}>
      {Eyebrow}
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 132, lineHeight: 0.9, color: tone.color, letterSpacing: '-0.04em' }}>{v}</div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-tertiary)' }}>out of 100</span>
      {Summary}
    </div>
  )
}
