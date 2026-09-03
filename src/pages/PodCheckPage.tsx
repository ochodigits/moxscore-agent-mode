import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { LanguageSelector } from '../components/LanguageSelector'
import { useI18n, type TranslationKey } from '../lib/i18n'
import { runBracketCheck, type PodDeckAnalysis } from '../lib/scryfallEngine'
import { podVerdict } from '../lib/podCheck'
import { runPodCheck } from '../lib/podCheckService'
import type { BracketResult } from '../lib/bracketEngine'
import { importDeckFromUrl, looksLikeDeckUrl, savePod, loadPod, podShareUrl } from '../lib/deckApi'
import { deferredPreviewEnabled } from '../lib/featureFlags'

const BRACKET_COLORS: Record<number, string> = {
  2: '#3fb950',
  3: '#d29922',
  4: '#f0883e',
  5: '#f85149',
}

interface PodDeckState {
  input: string
  analysis: PodDeckAnalysis | null
  error: string | null
}

const emptyDeck = (): PodDeckState => ({ input: '', analysis: null, error: null })

interface MetricRow {
  labelKey: TranslationKey
  value: (r: BracketResult) => string
}

const METRIC_ROWS: MetricRow[] = [
  { labelKey: 'pod.metric.power', value: (r) => r.powerScore.toFixed(1) },
  { labelKey: 'pod.metric.gameChangers', value: (r) => String(r.hardFlags.find((f) => f.code === 'gameChangers')?.count ?? 0) },
  { labelKey: 'pod.metric.combos', value: (r) => (r.comboCheck === 'ok' ? String(r.combos.length) : '—') },
  { labelKey: 'pod.metric.avgMv', value: (r) => r.softSignals.avgManaValue.toFixed(2) },
  { labelKey: 'pod.metric.interaction', value: (r) => String(r.softSignals.cheapInteractionCount) },
  { labelKey: 'pod.metric.fastMana', value: (r) => String(r.softSignals.fastManaCount) },
  { labelKey: 'pod.metric.tutors', value: (r) => String(r.softSignals.tutorCount) },
]

export default function PodCheckPage() {
  const navigate = useNavigate()
  const { podId } = useParams()
  const { t } = useI18n()
  const [decks, setDecks] = useState<PodDeckState[]>([emptyDeck(), emptyDeck()])
  const [running, setRunning] = useState(false)
  const [loadingPod, setLoadingPod] = useState(Boolean(podId))
  const [shareState, setShareState] = useState<'idle' | 'saving' | 'copied' | 'error'>('idle')
  const pro = deferredPreviewEnabled()

  // Shared pod: load decklists and analyze immediately.
  useEffect(() => {
    if (!podId) return
    let cancelled = false
    loadPod(podId)
      .then((loaded) => {
        if (cancelled) return
        const states = loaded.map((d) => ({ ...emptyDeck(), input: d.decklist }))
        setDecks(states)
        setLoadingPod(false)
        void analyzeAll(states)
      })
      .catch(() => {
        if (!cancelled) setLoadingPod(false)
      })
    return () => {
      cancelled = true
    }
  }, [podId])

  async function analyzeAll(states: PodDeckState[]) {
    setRunning(true)
    const outcomes = await runPodCheck(
      states.map((deck) => ({ input: deck.input })),
      {
        analyze: async (raw) => {
          const decklist = looksLikeDeckUrl(raw) ? (await importDeckFromUrl(raw)).decklist : raw
          return runBracketCheck(decklist)
        },
      },
    )
    const analyzed = outcomes.map((outcome, index): PodDeckState => ({
      input: states[index]?.input ?? outcome.input,
      analysis: outcome.analysis,
      error: outcome.error,
    }))
    setDecks(analyzed)
    setRunning(false)
  }

  async function handleShare() {
    const filled = decks.filter((d) => d.input.trim())
    if (filled.length < 2) return
    setShareState('saving')
    try {
      const id = await savePod(filled.map((d, i) => ({ decklist: d.input.trim(), label: `Deck ${i + 1}` })))
      await navigator.clipboard.writeText(podShareUrl(id)).catch(() => {})
      setShareState('copied')
      setTimeout(() => setShareState('idle'), 2500)
    } catch {
      setShareState('error')
      setTimeout(() => setShareState('idle'), 2500)
    }
  }

  const results = decks.map((d) => d.analysis?.bracket ?? null)
  const complete = results.filter((r): r is BracketResult => r !== null)
  const showResults = !running && complete.length >= 2 && complete.length === decks.filter((d) => d.input.trim()).length
  const verdict = showResults ? podVerdict(complete) : null
  const canRun = decks.filter((d) => d.input.trim()).length >= 2 && !running

  return (
    <main className="mox-pod">
      <header className="mox-results-head">
        <button className="mox-backlink" onClick={() => void navigate('/')}>
          ← {t('results.newDeck')}
        </button>
        <MoxLogo size={24} onClick={() => void navigate('/')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <LanguageSelector />
          {showResults && (
            <button className="mox-ghostbtn" onClick={() => void handleShare()} disabled={shareState === 'saving'}>
              {shareState === 'copied' ? t('pod.shared') : t('pod.share')}
            </button>
          )}
        </div>
      </header>

      <div className="mox-block-head" style={{ marginTop: 18 }}>
        <h1>{t('pod.title')}</h1>
        <p>{t('pod.sub')}</p>
      </div>

      {loadingPod ? (
        <p className="mox-bracket-note">…</p>
      ) : (
        <>
          <div className="mox-pod-inputs">
            {decks.map((deck, i) => (
              <div className="mox-pod-input" key={i}>
                <div className="mox-pod-input-head">
                  <span className="t-eyebrow">
                    {t('pod.deckLabel')} {i + 1}
                  </span>
                  {decks.length > 2 && (
                    <button className="mox-pod-remove" onClick={() => setDecks(decks.filter((_, j) => j !== i))}>
                      {t('pod.removeDeck')}
                    </button>
                  )}
                </div>
                <textarea
                  value={deck.input}
                  placeholder={t('pod.placeholder')}
                  onChange={(e) =>
                    setDecks(decks.map((d, j) => (j === i ? { ...d, input: e.target.value } : d)))
                  }
                />
                {deck.error && <div className="mox-pod-error">{deck.error}</div>}
              </div>
            ))}
          </div>
          <div className="mox-pod-actions">
            {decks.length < 4 && (
              <button className="mox-ghostbtn" onClick={() => setDecks([...decks, emptyDeck()])}>
                {t('pod.addDeck')}
              </button>
            )}
            <button className="mox-primarybtn" disabled={!canRun} onClick={() => void analyzeAll(decks)}>
              {running ? t('pod.running') : t('pod.run')}
            </button>
          </div>
        </>
      )}

      {verdict && (
        <div
          className={`mox-pod-verdict ${verdict.balanced ? 'balanced' : 'outlier'}`}
          style={{ borderColor: verdict.balanced ? '#3fb950' : '#f0883e' }}
        >
          {verdict.balanced ? (
            <>
              <strong>✓ {t('pod.verdictBalanced')}</strong>
              <span>{t('pod.verdictBalancedSub')}</span>
            </>
          ) : (
            <>
              <strong>
                {decks[verdict.outlierIndex!]?.analysis?.commanders[0] ?? `${t('pod.deckLabel')} ${verdict.outlierIndex! + 1}`}{' '}
                {t('pod.verdictOutlier')}
              </strong>
              <ul>
                {verdict.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {showResults && (
        <div className="mox-pod-tablewrap">
          <table className={`mox-pod-table${pro ? '' : ' teaser'}`}>
            <thead>
              <tr>
                <th />
                {decks.map(
                  (deck, i) =>
                    deck.analysis && (
                      <th key={i}>
                        {deck.analysis.commanderImage && (
                          <img src={deck.analysis.commanderImage} alt="" loading="lazy" />
                        )}
                        <span>{deck.analysis.commanders[0] ?? `${t('pod.deckLabel')} ${i + 1}`}</span>
                      </th>
                    ),
                )}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('pod.metric.bracket')}</td>
                {decks.map(
                  (deck, i) =>
                    deck.analysis && (
                      <td key={i}>
                        <span
                          className="mox-pod-bracket"
                          style={{ color: BRACKET_COLORS[deck.analysis.bracket.bracket] }}
                        >
                          {deck.analysis.bracket.bracket} · {deck.analysis.bracket.bracketName}
                        </span>
                      </td>
                    ),
                )}
              </tr>
              {METRIC_ROWS.map((row) => (
                <tr key={row.labelKey} className={pro ? '' : 'blurred'}>
                  <td>{t(row.labelKey)}</td>
                  {decks.map(
                    (deck, i) => deck.analysis && <td key={i}>{row.value(deck.analysis.bracket)}</td>,
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!pro && <p className="mox-bracket-note">{t('pod.teaser')}</p>}
        </div>
      )}
    </main>
  )
}
