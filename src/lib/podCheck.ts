/**
 * Pod Check verdict — deterministic comparison of 2–4 bracket results.
 * "Balanced" means every deck shares the same bracket AND the power-score
 * spread is at most 2 points; otherwise we name the outlier and its top two
 * differentiating reasons (hard flags first, then largest soft-signal deltas).
 * No LLM anywhere in this path.
 */
import type { BracketResult } from './bracketEngine.ts'

export interface PodVerdict {
  balanced: boolean
  /** Index of the strongest-deviation deck; null when balanced. */
  outlierIndex: number | null
  reasons: string[]
}

const POWER_SPREAD_MAX = 2

interface MetricDef {
  key: string
  value: (r: BracketResult) => number
  /** Sentence fragment for "more X than the rest of the pod". */
  describe: (own: number, othersAvg: number) => string
  /** Scale used to normalize deltas so different metrics are comparable. */
  scale: number
}

const METRICS: MetricDef[] = [
  {
    key: 'gameChangers',
    value: (r) => r.hardFlags.find((f) => f.code === 'gameChangers')?.count ?? 0,
    describe: (own, avg) => `${own} Game Changers vs ${avg.toFixed(1)} on average`,
    scale: 4,
  },
  {
    key: 'combos',
    value: (r) => r.combos.length,
    describe: (own, avg) => `${own} two-card combos vs ${avg.toFixed(1)} on average`,
    scale: 2,
  },
  {
    key: 'fastMana',
    value: (r) => r.softSignals.fastManaCount,
    describe: (own, avg) => `${own} fast-mana cards vs ${avg.toFixed(1)} on average`,
    scale: 4,
  },
  {
    key: 'tutors',
    value: (r) => r.softSignals.tutorCount,
    describe: (own, avg) => `${own} tutors vs ${avg.toFixed(1)} on average`,
    scale: 4,
  },
  {
    key: 'interaction',
    value: (r) => r.softSignals.cheapInteractionCount,
    describe: (own, avg) => `${own} pieces of cheap interaction vs ${avg.toFixed(1)} on average`,
    scale: 6,
  },
  {
    key: 'avgMv',
    // Inverted: a LOWER average mana value is the power outlier direction.
    value: (r) => -r.softSignals.avgManaValue,
    describe: (own, avg) => `average mana value ${(-own).toFixed(2)} vs ${(-avg).toFixed(2)} on average`,
    scale: 1,
  },
]

export function podVerdict(results: BracketResult[]): PodVerdict {
  if (results.length < 2) return { balanced: true, outlierIndex: null, reasons: [] }

  const brackets = results.map((r) => r.bracket)
  const powers = results.map((r) => r.powerScore)
  const sameBracket = new Set(brackets).size === 1
  const spread = Math.max(...powers) - Math.min(...powers)
  if (sameBracket && spread <= POWER_SPREAD_MAX) {
    return { balanced: true, outlierIndex: null, reasons: [] }
  }

  // Outlier = deck whose (bracket, power) deviates most from the pod mean;
  // bracket distance dominates so a lone bracket-5 deck always wins over a
  // mere power gap.
  const meanBracket = brackets.reduce((s, b) => s + b, 0) / brackets.length
  const meanPower = powers.reduce((s, p) => s + p, 0) / powers.length
  let outlierIndex = 0
  let best = -1
  let bestStrength = -Infinity
  results.forEach((_, i) => {
    const deviation = Math.abs(brackets[i]! - meanBracket) * 10 + Math.abs(powers[i]! - meanPower)
    // In a 2-deck pod every deck deviates equally from the mean, so break
    // ties toward the stronger deck — that is the one warping the pod.
    const strength = brackets[i]! * 10 + powers[i]!
    if (deviation > best || (deviation === best && strength > bestStrength)) {
      best = deviation
      bestStrength = strength
      outlierIndex = i
    }
  })
  const outlier = results[outlierIndex]!
  const others = results.filter((_, i) => i !== outlierIndex)

  // Reasons: hard flags the others don't share, then largest soft deltas.
  const reasons: string[] = []
  for (const flag of outlier.hardFlags) {
    if (flag.code === 'earlyCombos' || flag.code === 'massLandDenial') {
      const othersHave = others.some((o) => o.hardFlags.some((f) => f.code === flag.code))
      if (!othersHave) reasons.push(flag.message)
    }
  }

  const scored = METRICS.map((m) => {
    const own = m.value(outlier)
    const avg = others.reduce((s, o) => s + m.value(o), 0) / others.length
    return { delta: (own - avg) / m.scale, text: m.describe(own, avg) }
  })
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta)

  for (const m of scored) {
    if (reasons.length >= 2) break
    reasons.push(m.text)
  }
  if (reasons.length === 0) {
    reasons.push(`power score ${outlier.powerScore.toFixed(1)} vs pod average ${meanPower.toFixed(1)}`)
  }

  return { balanced: false, outlierIndex, reasons: reasons.slice(0, 2) }
}
