import { useState } from 'react'
import { runBracketTuner, type OwnershipMode, type TunerResult } from '../lib/bracketTuner'
import { cardmarketUrl, tcgplayerUrl } from '../lib/linkBuilder'
import type { LocalCard } from '../lib/cardDatabase'
import { useI18n } from '../lib/i18n'
import { explainTunerSwaps, submitAiExplanationFeedback, type AiExplanationResponse } from '../lib/aiExplanationApi'
import type { AuthenticatedFetch } from '../lib/accountApi'

interface BracketTunerProps {
  decklist: string
  collection?: string[]
  aiAccess?: {
    request: AuthenticatedFetch
    monthlyLimit: number
    monthlyRemaining: number
  }
  onApplySwap?: (add: string, cut?: string) => void
  onHover: (card: LocalCard, x: number, y: number) => void
  onLeave: () => void
}

const hoverCard = (name: string): LocalCard => ({ name, cmc: 0, cost: '', type: '', cats: [], note: '', qty: 1 })

export function BracketTuner({ decklist, collection, aiAccess, onApplySwap, onHover, onLeave }: BracketTunerProps) {
  const { t } = useI18n()
  const [target, setTarget] = useState<2 | 3 | 4 | 5>(2)
  const [budget, setBudget] = useState(5)
  const [ownershipMode, setOwnershipMode] = useState<OwnershipMode>('prefer-owned')
  const [exclusions, setExclusions] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TunerResult | null>(null)
  const [error, setError] = useState(false)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [aiRunning, setAiRunning] = useState(false)
  const [aiRequestId, setAiRequestId] = useState<string | null>(null)
  const [aiResponse, setAiResponse] = useState<AiExplanationResponse | null>(null)
  const [aiMessage, setAiMessage] = useState<string | null>(null)
  const [feedbackSent, setFeedbackSent] = useState(false)

  // explanations is 1:1 with cut+add pairs only — walk the same way reasoning is applied.
  const swapExplanations = result && aiResponse
    ? (() => {
        let explainIndex = 0
        return result.swaps.map((swap) => {
          if (!swap.cut || !swap.add) return undefined
          const explanation = aiResponse.explanations[explainIndex]
          explainIndex += 1
          return explanation
        })
      })()
    : []

  async function run() {
    setRunning(true)
    setError(false)
    setResult(null)
    setApplied(new Set())
    setAiRequestId(null)
    setAiResponse(null)
    setAiMessage(null)
    setFeedbackSent(false)
    try {
      setResult(await runBracketTuner({
        decklist,
        targetBracket: target,
        budgetEurPerCard: budget,
        collection,
        ownershipMode,
        excludedCardNames: exclusions.split(/[\n,]/).map((name) => name.trim()).filter(Boolean),
      }))
    } catch {
      setError(true)
    } finally {
      setRunning(false)
    }
  }

  async function explainWithAi() {
    if (!aiAccess || !result || result.swaps.length === 0) return
    const explainable = result.swaps.filter((swap) => swap.cut && swap.add)
    if (explainable.length === 0) {
      setAiMessage('Add-only and cut-only moves stay local — Pro AI explains only cut/add pairs.')
      return
    }
    const requestId = aiRequestId ?? crypto.randomUUID()
    if (aiRequestId === null) setAiRequestId(requestId)
    setAiRunning(true)
    setAiMessage(null)
    try {
      const response = await explainTunerSwaps(aiAccess.request, requestId, explainable, result.targetBracket)
      setAiResponse(response)
      setResult((current) => {
        if (current === null) return current
        let explainIndex = 0
        return {
          ...current,
          swaps: current.swaps.map((swap) => {
            if (!swap.cut || !swap.add) return swap
            const explanation = response.explanations[explainIndex]
            explainIndex += 1
            return {
              ...swap,
              reasoning: explanation?.source === 'provider' ? explanation.reasoning : swap.reasoning,
            }
          }),
        }
      })
      if (response.fallbackReason !== null) {
        setAiMessage('Deterministic explanations are shown because the provider path was unavailable or rejected.')
      } else {
        setAiMessage('Pro explanations applied to the exact deterministic cut/add pairs (add-only and cut-only stay local).')
      }
    } catch {
      setAiMessage('AI explanations are temporarily unavailable. The deterministic swaps and explanations are unchanged.')
    } finally {
      setAiRunning(false)
    }
  }

  async function sendFeedback(rating: 'up' | 'down') {
    if (!aiAccess || !aiResponse || feedbackSent) return
    try {
      await submitAiExplanationFeedback(
        aiAccess.request,
        aiResponse.requestId,
        rating,
        rating === 'up' ? 'helpful' : 'irrelevant',
      )
      setFeedbackSent(true)
    } catch {
      setAiMessage('The explanations remain available, but feedback could not be recorded.')
    }
  }

  return (
    <div className="mox-tuner">
      <p className="mox-bracket-note">Deterministic guidance only: auto-upgrades when below target and cuts down when above; Game Changers, tutors, and fast mana are cut-only on the way down. Card candidates and prices are fetched at run time.</p>
      <div className="mox-tuner-controls">
        <label>
          {t('tuner.target')}
          <select value={target} onChange={(e) => setTarget(Number(e.target.value) as 2 | 3 | 4 | 5)}>
            <option value={2}>2 · Core</option>
            <option value={3}>3 · Upgraded</option>
            <option value={4}>4 · Optimized</option>
            <option value={5}>5 · cEDH</option>
          </select>
        </label>
        <label>
          Ownership
          <select value={ownershipMode} onChange={(event) => setOwnershipMode(event.target.value as OwnershipMode)}>
            <option value="prefer-owned">Prefer owned</option>
            <option value="owned-only">Owned only</option>
            <option value="any">Any card</option>
          </select>
        </label>
        <label>
          Exclude cards
          <input
            value={exclusions}
            onChange={(event) => setExclusions(event.target.value)}
            placeholder="Names, separated by commas"
            style={{ width: 220 }}
          />
        </label>
        <label>
          {t('tuner.budget')}
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={budget}
            onChange={(e) => setBudget(Math.max(0.5, Number(e.target.value) || 0.5))}
          />
        </label>
        <button className="mox-primarybtn" disabled={running} onClick={() => void run()}>
          {running ? t('tuner.running') : t('tuner.run')}
        </button>
      </div>

      {error && <p className="mox-pod-error">{t('tuner.error')}</p>}

      {result && (
        <div className="mox-tuner-result">
          <p className={`mox-tuner-status ${result.achievable ? 'ok' : 'warn'}`}>
            {result.achievable ? t('tuner.achieved') : t('tuner.notAchievable')}{' '}
            <span>
              {t('tuner.resulting')}: {result.resultingBracket} · {result.resultingPower.toFixed(1)}/10
            </span>
          </p>

          {result.swaps.length === 0 ? (
            <p className="mox-bracket-note">{t('tuner.empty')}</p>
          ) : (
            <>
              <ul className="mox-tuner-swaps">
                {result.swaps.map((swap, index) => {
                  const cutOnly = swap.add === null
                  const addOnly = swap.cut === null
                  const key = addOnly
                    ? `add-only→${swap.add}`
                    : cutOnly
                      ? `${swap.cut}→cut-only`
                      : `${swap.cut}→${swap.add}`
                  return (
                    <li key={key}>
                      <div className="mox-tuner-swaprow">
                        {addOnly ? (
                          <span
                            className="mox-tuner-add"
                            onMouseMove={(e) => onHover(hoverCard(swap.add!), e.clientX, e.clientY)}
                            onMouseLeave={onLeave}
                          >
                            + {swap.add}
                          </span>
                        ) : (
                          <>
                            <span
                              className="mox-tuner-cut"
                              onMouseMove={(e) => onHover(hoverCard(swap.cut!), e.clientX, e.clientY)}
                              onMouseLeave={onLeave}
                            >
                              − {swap.cut}
                            </span>
                            <span className="mox-tuner-arrow">→</span>
                            {cutOnly ? (
                              <span className="mox-tuner-add">cut only</span>
                            ) : (
                              <span
                                className="mox-tuner-add"
                                onMouseMove={(e) => onHover(hoverCard(swap.add!), e.clientX, e.clientY)}
                                onMouseLeave={onLeave}
                              >
                                + {swap.add}
                              </span>
                            )}
                          </>
                        )}
                        {!cutOnly && (
                          <span className={`mox-tuner-badge ${swap.owned ? 'owned' : 'missing'}`}>
                            {swap.owned ? t('tuner.owned') : t('tuner.missing')}
                          </span>
                        )}
                        {swap.addEur !== null && <span className="mox-tuner-price">€{swap.addEur.toFixed(2)}</span>}
                        {!cutOnly && swap.add !== null && (
                          <span className="mox-tuner-links">
                            <a href={cardmarketUrl(swap.add)} target="_blank" rel="noreferrer">
                              CM
                            </a>
                            <a href={tcgplayerUrl(swap.add)} target="_blank" rel="noreferrer">
                              TCG
                            </a>
                          </span>
                        )}
                        {onApplySwap && (
                          <button
                            className="mox-ghostbtn"
                            disabled={applied.has(key)}
                            onClick={() => {
                              if (addOnly) onApplySwap(swap.add!)
                              else onApplySwap(swap.add ?? '', swap.cut ?? undefined)
                              setApplied((current) => new Set([...current, key]))
                            }}
                          >
                            {applied.has(key) ? '✓' : cutOnly ? '−' : addOnly ? '+' : '⇄'}
                          </button>
                        )}
                      </div>
                      <p className="mox-tuner-reason">{swap.reasoning}</p>
                      {swapExplanations[index] && (
                        <p className="mox-bracket-note">
                          {swapExplanations[index]!.source === 'provider' ? 'Pro AI explanation' : 'Deterministic fallback'}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="mox-tuner-total">
                {t('tuner.totalMissing')}: <strong>€{result.totalMissingEur.toFixed(2)}</strong>
              </p>
              {aiAccess && (
                <div className="mox-tuner-ai">
                  <p className="mox-bracket-note">
                    Pro can explain these exact swaps only. Up to {aiAccess.monthlyLimit} sessions per month; {aiResponse?.quota.monthlyRemaining ?? aiAccess.monthlyRemaining} remaining. The provider receives card names, role, cut reason, and target bracket—not the decklist. Output is heuristic, strictly filtered, and falls back to local templates.
                  </p>
                  <button
                    className="mox-ghostbtn"
                    disabled={aiRunning || (aiResponse?.quota.monthlyRemaining ?? aiAccess.monthlyRemaining) <= 0}
                    onClick={() => void explainWithAi()}
                  >
                    {aiRunning ? 'Explaining…' : 'Explain exact swaps with Pro AI'}
                  </button>
                  {aiMessage && <p className="mox-bracket-note" role="status">{aiMessage}</p>}
                  {aiResponse
                    && aiResponse.fallbackReason !== 'control_unavailable'
                    && (aiResponse.providerCalled || aiResponse.replayed) && (
                    <div className="mox-tuner-feedback" aria-label="Explanation feedback">
                      <span>Useful?</span>
                      <button className="mox-ghostbtn" disabled={feedbackSent} onClick={() => void sendFeedback('up')}>Thumbs up</button>
                      <button className="mox-ghostbtn" disabled={feedbackSent} onClick={() => void sendFeedback('down')}>Thumbs down</button>
                      {feedbackSent && <span>Feedback recorded.</span>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {result.notes.map((n, i) => (
            <p className="mox-bracket-note" key={i}>
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
