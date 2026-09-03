import { useState, useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { ThemeToggle } from '../components/ThemeToggle'
import { ScoreGauge } from '../components/ScoreGauge'
import { CategoryCard } from '../components/CategoryCard'
import { SuggestionPanel } from '../components/SuggestionPanel'
import { ManaCurveChart } from '../components/ManaCurveChart'
import { BracketPanel } from '../components/BracketPanel'
import { BracketTuner } from '../components/BracketTuner'
import { Sidebar } from '../components/Sidebar'
import { useCardPreview } from '../hooks/useCardPreview'
import { useAnalysis } from '../hooks/useAnalysis'
import { deleteSharedDeck, saveDeck, loadDeck, shareUrl } from '../lib/deckApi'
import { CardShuffleLoader } from '../components/CardShuffleLoader'
import { useI18n } from '../lib/i18n'
import { DEFAULT_FORMAT, FORMAT_BY_ID, type MtgFormat } from '../lib/formats'
import { sharingUiEnabled } from '../lib/releaseConfig'
import { persistenceUiEnabled } from '../lib/supabaseClient'
import { createSavedDeck, deleteSavedDeck, getAccountMe, getCollection, saveDeckVersion, type AccountMe } from '../lib/accountApi'
import { useAuth } from '../lib/useAuth'
import { deterministicTunerEnabled } from '../lib/featureFlags'

// Mirror the last analyzed deck to sessionStorage so /results survives a
// refresh or a fresh tab (analysis state otherwise only lives in
// location.state and would be lost).
const SESSION_KEY = 'moxscore:last-deck'
const SHARING_ENABLED = sharingUiEnabled()
const TUNER_ENABLED = deterministicTunerEnabled()

function readSessionDeck(): { decklist: string; formatId?: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as { decklist: string; formatId?: string }) : null
  } catch {
    return null
  }
}

function writeSessionDeck(decklist: string, formatId: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ decklist, formatId }))
  } catch {
    /* storage full or unavailable — deep-link resilience is best-effort */
  }
}

interface ResultsPageProps {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}

function ResultState({ title, body, onBack }: { title: string; body: string; onBack: () => void }) {
  return (
    <main className="mox-state">
      <MoxLogo size={28} onClick={onBack} />
      <div className="mox-state-card">
        <div className="t-eyebrow">Analysis</div>
        <h1>{title}</h1>
        <p>{body}</p>
        <button className="mox-primarybtn" onClick={onBack}>
          Paste a decklist
        </button>
      </div>
    </main>
  )
}

export default function ResultsPage({ theme, onToggleTheme }: ResultsPageProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { slug } = useParams()
  const state = location.state as { decklist: string } | null
  const sessionDeck = !state?.decklist && !slug ? readSessionDeck() : null
  const initialDecklist = state?.decklist ?? sessionDeck?.decklist ?? ''

  const [decklist, setDecklist] = useState(initialDecklist)
  const [format, setFormat] = useState<MtgFormat>(
    (sessionDeck?.formatId !== undefined ? FORMAT_BY_ID[sessionDeck.formatId] : undefined) ?? DEFAULT_FORMAT,
  )
  const { data: result, isLoading: analysisLoading, isError, error } = useAnalysis(decklist, format)
  const [slugLoading, setSlugLoading] = useState(Boolean(slug && !initialDecklist))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [addQueue, setAddQueue] = useState<{ name: string; ts: number } | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(slug ? shareUrl(slug) : null)
  const [shareDeletionToken, setShareDeletionToken] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const { t } = useI18n()
  const { onHover, onLeave, previewNode } = useCardPreview()
  const { status: authStatus, authenticatedFetch } = useAuth()
  const { onHover: onHoverCmd, onLeave: onLeaveCmd, previewNode: commanderPreviewNode } = useCardPreview({ size: 340 })
  const [animateScore, setAnimateScore] = useState(true)
  const [savingDeck, setSavingDeck] = useState(false)
  const [savedDeck, setSavedDeck] = useState(false)
  const [saveDeckError, setSaveDeckError] = useState<string | null>(null)
  const [ownedCardNames, setOwnedCardNames] = useState<string[]>([])
  const [accountMe, setAccountMe] = useState<AccountMe | null>(null)
  const canSaveDeck = persistenceUiEnabled() && authStatus === 'authenticated'

  // Keep the sessionStorage mirror current so refresh / new tab works.
  useEffect(() => {
    if (decklist) writeSessionDeck(decklist, format.id)
  }, [decklist, format.id])

  useEffect(() => {
    if (!TUNER_ENABLED || !canSaveDeck) {
      return
    }
    let cancelled = false
    void getCollection(authenticatedFetch)
      .then(({ cards }) => {
        if (!cancelled) setOwnedCardNames(cards.map((card) => card.name))
      })
      .catch(() => {
        if (!cancelled) setOwnedCardNames([])
      })
    return () => { cancelled = true }
  }, [authenticatedFetch, canSaveDeck])

  useEffect(() => {
    if (!TUNER_ENABLED || authStatus !== 'authenticated') {
      return
    }
    let cancelled = false
    void getAccountMe(authenticatedFetch)
      .then((me) => { if (!cancelled) setAccountMe(me) })
      .catch(() => { if (!cancelled) setAccountMe(null) })
    return () => { cancelled = true }
  }, [authStatus, authenticatedFetch])

  // When opened via /d/:slug, load the saved decklist (useAnalysis takes it
  // from there) and restore the scoring format it was shared with.
  useEffect(() => {
    if (!slug || initialDecklist) return
    let cancelled = false
    loadDeck(slug)
      .then((d) => {
        if (cancelled) return
        setDecklist(d.decklist)
        const savedFormat = d.format !== null ? FORMAT_BY_ID[d.format] : undefined
        if (savedFormat) setFormat(savedFormat)
        setSlugLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Could not load deck.')
        setSlugLoading(false)
      })
    return () => { cancelled = true }
  }, [slug, initialDecklist])

  if (slugLoading) {
    return (
      <main className="mox-state">
        <MoxLogo size={28} onClick={() => void navigate('/')} />
        <div className="mox-state-card">
          <div className="t-eyebrow">Shared Deck</div>
          <h1>Loading deck</h1>
          <p>Pulling the shared decklist into the analyzer.</p>
        </div>
      </main>
    )
  }

  if (analysisLoading && !result) {
    return <CardShuffleLoader />
  }

  if (!decklist || !result) {
    const msg = loadError ?? (isError ? (error?.message ?? 'Analysis failed.') : 'No deck to analyze.')
    return <ResultState title="No analysis yet" body={msg} onBack={() => void navigate('/')} />
  }

  function handleRerun(text: string) {
    setAnimateScore(false)
    setDecklist(text)
    setShareLink(null)
    setCopied(false)
    setShareError(null)
    setTimeout(() => { setAnimateScore(true) }, 50)
  }

  function handleAddCard(name: string) {
    setAddQueue({ name, ts: Date.now() })
    setSidebarOpen(true)
  }

  // Remove/decrement one copy of `name` from a decklist's text lines.
  function removeFromLines(lines: string[], name: string): string[] {
    return lines
      .map((line) => {
        const m = line.match(/^(\d+)x?\s+(.+)$/)
        if (!m || m[1] === undefined || m[2] === undefined) return line
        const qty = parseInt(m[1], 10)
        const cardName = m[2].trim()
        if (cardName.toLowerCase() !== name.toLowerCase()) return line
        return qty > 1 ? `${qty - 1} ${cardName}` : null
      })
      .filter((l): l is string => l !== null)
  }

  function handleRemoveCard(name: string) {
    handleRerun(removeFromLines(decklist.split('\n'), name).join('\n'))
    setSidebarOpen(true)
  }

  function handleApplyTunerSwap(add: string, cut?: string) {
    let next = cut ? removeFromLines(decklist.split('\n'), cut) : decklist.split('\n')
    if (add.trim()) next = [...next, `1 ${add.trim()}`]
    handleRerun(next.join('\n'))
    setSidebarOpen(true)
  }

  async function handleShare() {
    // Already have a link → just copy it again.
    if (shareLink) {
      await navigator.clipboard.writeText(shareLink).catch(() => {})
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      return
    }
    setSharing(true)
    setShareError(null)
    try {
      const receipt = await saveDeck({
        decklist,
        name: result!.commander ?? undefined,
        commander: result!.commander,
        score: result!.score,
        format: format.id,
      })
      const link = shareUrl(receipt.slug)
      setShareLink(link)
      setShareDeletionToken(receipt.deletionToken)
      await navigator.clipboard.writeText(link).catch(() => {})
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not create share link.')
    } finally {
      setSharing(false)
    }
  }

  async function handleDeleteShare() {
    if (!shareLink || sharing) return
    const slugFromLink = shareLink.split('/d/')[1]
    const token = shareDeletionToken ?? window.prompt('Enter the share deletion code.')?.trim() ?? ''
    if (!slugFromLink || !token || !window.confirm('Permanently delete this shared deck link?')) return
    setSharing(true)
    setShareError(null)
    try {
      await deleteSharedDeck(slugFromLink, token)
      setShareLink(null)
      setShareDeletionToken(null)
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not delete share link.')
    } finally {
      setSharing(false)
    }
  }

  async function handleSaveDeck() {
    if (!result || savingDeck || savedDeck) return
    setSavingDeck(true)
    setSaveDeckError(null)
    let createdDeckId: string | null = null
    try {
      const deck = await createSavedDeck(authenticatedFetch, result.commander ?? 'Untitled Commander deck')
      createdDeckId = deck.id
      await saveDeckVersion(authenticatedFetch, {
        deckId: deck.id,
        decklist,
        analysisSnapshot: result as unknown as Record<string, unknown>,
        analyzerVersion: 'v2-preview',
        curatedDataVersion: '2026-07-31',
      })
      setSavedDeck(true)
    } catch (cause) {
      if (createdDeckId !== null) void deleteSavedDeck(authenticatedFetch, createdDeckId).catch(() => {})
      setSaveDeckError(cause instanceof Error ? cause.message : 'Could not save this deck.')
    } finally {
      setSavingDeck(false)
    }
  }

  const accent = 'var(--accent)'

  return (
    <div className={`mox-results${sidebarOpen ? ' with-sidebar' : ''}`}>
      {previewNode}
      {commanderPreviewNode}

      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        onClose={() => setSidebarOpen(false)}
        entries={result.entries}
        onRerun={handleRerun}
        addQueue={addQueue}
        deckLimit={format.deckLimit}
      />

      <div className="mox-results-main">
        <header className="mox-results-head">
          <button className="mox-backlink" onClick={() => void navigate('/')}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5M12 5l-7 7 7 7" />
            </svg>
            {t('results.newDeck')}
          </button>
          <MoxLogo size={24} onClick={() => void navigate('/')} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {(SHARING_ENABLED || shareLink) && (
              <button
                type="button"
                className="mox-ghostbtn"
                onClick={() => void handleShare()}
                disabled={sharing}
                title={shareError ?? t('results.shareTitle')}
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4m0 0L8 6m4-4v14" />
                </svg>
                {sharing ? t('results.saving') : copied ? t('results.copied') : shareLink ? t('results.copyLink') : t('results.share')}
              </button>
            )}
            {canSaveDeck && (
              <button type="button" className="mox-ghostbtn" onClick={() => void handleSaveDeck()} disabled={savingDeck || savedDeck}>
                {savingDeck ? 'Saving…' : savedDeck ? 'Saved' : 'Save deck'}
              </button>
            )}
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>
        </header>

        <div className="mox-results-grid">
          {/* Score gauge */}
          <div className="mox-gauge-card">
            <ScoreGauge
              score={result.score}
              summary={result.summary}
              variant="bars"
              subScores={result.subScores}
              animate={animateScore}
            />
            {result.commander && (
              <div className="mox-commander">
                <div className="t-eyebrow" style={{ fontSize: 11 }}>{t('results.commander')}</div>
                <div
                  className="mox-commander-name"
                  style={{ cursor: 'default' }}
                  onMouseMove={(e) =>
                    onHoverCmd(
                      { name: result.commander!, cmc: 0, cost: '', type: '', cats: [], note: '', qty: 1 },
                      e.clientX,
                      e.clientY,
                    )
                  }
                  onMouseLeave={onLeaveCmd}
                >
                  {result.commander}
                </div>
              </div>
            )}
            {result.unknown.length > 0 && (
              <div className="mox-unknown mox-unknown-list">
                <strong>{result.unknown.length} card{result.unknown.length === 1 ? '' : 's'} not recognized.</strong>
                <span>Scoring is conservative for: {result.unknown.slice(0, 6).map((c) => c.name).join(', ')}{result.unknown.length > 6 ? ', ...' : ''}</span>
              </div>
            )}
            <div className={`mox-confidence ${result.confidence.level}`}>
              <strong>{result.confidence.level.toUpperCase()} confidence</strong>
              <span>{result.confidence.message}</span>
              <small>{result.confidence.recognized} recognized / {result.confidence.unknown} unknown</small>
            </div>
            {shareError && (
              <div className="mox-share-error">
                {shareError} You can still copy your decklist from the editor and try sharing again after storage is configured.
              </div>
            )}
            {shareDeletionToken && (
              <div className="mox-bracket-note" style={{ marginTop: 10 }}>
                <strong>Share deletion code:</strong> <code>{shareDeletionToken}</code>{' '}
                <button className="mox-inlinebtn" type="button" onClick={() => void navigator.clipboard.writeText(shareDeletionToken).catch(() => {})}>Copy code</button>
                <br />Save this code. It is required to delete the shared link and is not shown again after you leave this page.
              </div>
            )}
            {shareLink && (shareDeletionToken || SHARING_ENABLED) && (
              <button className="mox-inlinebtn" type="button" onClick={() => void handleDeleteShare()} disabled={sharing}>Delete shared link</button>
            )}
            {saveDeckError && <div className="mox-share-error">{saveDeckError}</div>}
          </div>

          {/* Category breakdown */}
          <div>
            <div className="mox-block-head">
              <h2>{t('results.catBreakdown')}</h2>
              <p>{t('results.catBreakdownSub')}</p>
            </div>
            <div className="mox-methodology">
              <strong>{t('results.methodHead')}</strong>
              <span>Recommended counts are relative to this deck: the ramp target and land window scale with your actual average mana value — a low-curve aggro deck and a big-mana ramp deck get different baselines. Interaction counts targeted answers; board wipes are scored as their own window (a few help, too many hurt). Win conditions include combos, alternate wincons, and a genuine combat plan.</span>
              <span style={{ display: 'block', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                Targets for this deck: ramp {result.params.idealRamp} · draw {result.params.idealDraw} · interaction {result.params.idealInteraction} · board wipes {result.params.idealWipesMin}–{result.params.idealWipesMax} · protection {result.params.idealProtection} · lands {result.params.idealLandPeak - 1}–{result.params.idealLandPeak + 1} · avg mana value ≈{result.params.idealCmc.toFixed(1)}
              </span>
            </div>
            <div className="mox-cat-grid">
              <CategoryCard catKey="ramp" score={result.subScores.ramp} feedback={result.feedback.ramp} metric={`${result.counts.ramp} ramp spells detected`} cards={result.groups.ramp} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="draw" score={result.subScores.draw} feedback={result.feedback.draw} metric={`${result.counts.draw} draw effects detected`} cards={result.groups.draw} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="interaction" score={result.subScores.interaction} feedback={result.feedback.interaction} metric={`${result.counts.interaction} targeted answers`} cards={result.groups.interaction} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="wipes" score={result.subScores.wipes} feedback={result.feedback.wipes} metric={`${result.counts.wipes} board wipes`} cards={result.groups.wipes} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="protection" score={result.subScores.protection} feedback={result.feedback.protection} metric={`${result.counts.protection} protection effects`} cards={result.groups.protection} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="curve" score={result.subScores.curve} feedback={result.feedback.curve} metric={`avg CMC: ${result.avgCmc.toFixed(2)}`} cards={result.groups.curve} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="lands" score={result.subScores.lands} feedback={result.feedback.lands} metric={`${result.counts.lands} lands detected`} cards={result.groups.lands} onHover={onHover} onLeave={onLeave} />
              <CategoryCard catKey="wincons" score={result.subScores.wincons} feedback={result.feedback.wincons} metric={`${result.counts.wincons} win conditions`} cards={result.groups.wincons} onHover={onHover} onLeave={onLeave} />
            </div>
          </div>

          {/* Commander bracket */}
          {result.bracket && (
            <div>
              <div className="mox-block-head">
                <h2>{t('bracket.title')}</h2>
                <p>{t('bracket.sub')}</p>
              </div>
              <BracketPanel
                bracket={result.bracket}
                onHover={onHover}
                onLeave={onLeave}
              />
            </div>
          )}

          {TUNER_ENABLED && (
            <div>
              <div className="mox-block-head">
                <h2>Bracket Tuner</h2>
                <p>Test deterministic, budget-aware swaps. Eligible Pro accounts can separately explain only the exact validated pairs.</p>
              </div>
              <BracketTuner
                decklist={decklist}
                collection={ownedCardNames}
                aiAccess={authStatus === 'authenticated' && accountMe?.capabilities.ai_explanations ? {
                  request: authenticatedFetch,
                  monthlyLimit: accountMe.quotas.ai_explanations.monthly_limit,
                  monthlyRemaining: accountMe.quotas.ai_explanations.monthly_remaining,
                } : undefined}
                onApplySwap={handleApplyTunerSwap}
                onHover={onHover}
                onLeave={onLeave}
              />
            </div>
          )}

          {/* Mana curve */}
          <div>
            <div className="mox-block-head">
              <h2>{t('results.manaCurve')}</h2>
              <p>{t('results.manaCurveSub')}</p>
            </div>
            <ManaCurveChart curve={result.curve} accent={accent} />
          </div>

          {/* Suggestions */}
          <div>
            <div className="mox-block-head">
              <h2>{t('results.upgrades')}</h2>
              <p>{t('results.upgradesSub')}</p>
            </div>
            <SuggestionPanel suggestions={result.suggestions} onAdd={handleAddCard} onRemove={handleRemoveCard} onHover={onHover} onLeave={onLeave} />
          </div>
        </div>
      </div>
    </div>
  )
}
