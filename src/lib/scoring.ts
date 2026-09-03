// The single scoring module used by every analysis path (Scryfall live
// engine, offline local fallback, and the pure analysis helpers). All score
// functions are parameterized by format- and curve-derived ideals and
// hard-clamped to [0, 100] — no path may ever produce a sub-score above 100.

import type { MtgFormat } from './formats.ts'

export type CategoryKey =
  | 'ramp'
  | 'draw'
  | 'interaction'
  | 'wipes'
  | 'protection'
  | 'curve'
  | 'lands'
  | 'wincons'

export interface ScoringParams {
  idealRamp: number
  idealDraw: number
  idealInteraction: number
  idealWipesMin: number
  idealWipesMax: number
  idealProtection: number
  idealLandMin: number
  idealLandPeak: number
  idealLandMax: number
  idealCmc: number
  /** True when the ideals were adjusted for this deck's actual curve. */
  curveRelative: boolean
}

// Weight rebalance after splitting Board Wipes out of Interaction and adding
// Protection (both beta-tester requests). Interaction gave up 4 points and
// Curve/Lands gave up 4 to fund the two new 6-point categories; the original
// 20/20/20/15/15/10 spirit (velocity > mana base > wincons) is preserved.
export const WEIGHTS: Record<CategoryKey, number> = {
  ramp: 0.18,
  draw: 0.18,
  interaction: 0.16,
  wipes: 0.06,
  protection: 0.06,
  curve: 0.12,
  lands: 0.14,
  wincons: 0.1,
}

export function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export interface CurveContext {
  /** Average mana value of the deck's non-land cards. */
  avgCmc: number
}

/**
 * Ideal category counts for a format — optionally adjusted to the deck's own
 * curve. A low-curve aggro deck needs less ramp and fewer lands than a
 * ramp-into-big-things deck, so when `curve` is provided the ramp ideal and
 * land window shift with the deck's average mana value instead of applying
 * one flat number to every deck.
 */
export function formatParams(format: MtgFormat, curve?: CurveContext): ScoringParams {
  const scale = format.deckLimit / 100
  const baseCmc = format.deckLimit <= 60 ? 2.5 : 3.0

  // Curve-relative adjustments (Tier: dynamic scoring). Each 0.5 of average
  // mana value above/below the format baseline shifts the ramp ideal by ~2
  // and the land peak by ~1, within sane bounds.
  const cmcDelta = curve ? curve.avgCmc - baseCmc : 0
  const rampShift = Math.round(cmcDelta * 4)
  const landShift = Math.round(cmcDelta * 2)

  const idealRamp = Math.max(3, Math.round(clampRange(10 + rampShift, 6, 14) * scale))
  const landPeak = Math.round(clampRange(37 + landShift, 33, 40) * scale)

  return {
    idealRamp,
    idealDraw: Math.max(3, Math.round(10 * scale)),
    idealInteraction: Math.max(3, Math.round(10 * scale)),
    idealWipesMin: Math.max(1, Math.round(2 * scale)),
    idealWipesMax: Math.max(2, Math.round(4 * scale)),
    idealProtection: Math.max(2, Math.round(4 * scale)),
    idealLandMin: Math.max(1, landPeak - 5),
    idealLandPeak: landPeak,
    idealLandMax: landPeak + 3,
    idealCmc: baseCmc,
    curveRelative: Boolean(curve),
  }
}

function clampRange(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Linear count-vs-ideal score shared by ramp / draw / interaction / protection. */
export function scoreCount(count: number, ideal: number): number {
  if (ideal <= 0) return 100
  return clamp100((count / ideal) * 100)
}

export const scoreRamp = scoreCount
export const scoreDraw = scoreCount
export const scoreInteraction = scoreCount
export const scoreProtection = scoreCount

/**
 * Board wipes are a window, not a ladder: too few leaves you exposed, but a
 * creature-heavy deck stuffed with wipes hurts its own game plan.
 */
export function scoreBoardWipes(count: number, min: number, max: number): number {
  if (count <= 0) return 30
  if (count < min) return 70
  if (count <= max) return 100
  return clamp100(100 - (count - max) * 15)
}

export function scoreWincons(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return 50
  return 100
}

export function scoreCurve(avgCmc: number, idealCmc: number): number {
  return clamp100(100 - Math.abs(avgCmc - idealCmc) * 25)
}

/**
 * Land-count score. Peak ±1 is 100; below the peak interpolates 30→100 from
 * the minimum; above the peak tapers 90→70 down to the max, then 60 beyond.
 * The taper (rather than the old interpolation formula) is what keeps 39–40
 * land decks from scoring above 100.
 */
export function scoreLands(
  count: number,
  p: Pick<ScoringParams, 'idealLandMin' | 'idealLandPeak' | 'idealLandMax'>,
): number {
  const { idealLandMin: min, idealLandPeak: peak, idealLandMax: max } = p
  if (count < min) return 0
  if (count > max) return 60
  if (Math.abs(count - peak) <= 1) return 100
  if (count < peak) {
    const span = Math.max(1, peak - 1 - min)
    return clamp100(Math.round(((count - min) / span) * 70 + 30))
  }
  // count in (peak + 1, max]: gentle taper, never above 90
  const span = Math.max(1, max - (peak + 1))
  return clamp100(90 - Math.round(((count - (peak + 1)) / span) * 20))
}

export function composeScore(subScores: Partial<Record<string, number>>): number {
  let total = 0
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += clamp100(subScores[key] ?? 0) * weight
  }
  return clamp100(Math.round(total))
}
