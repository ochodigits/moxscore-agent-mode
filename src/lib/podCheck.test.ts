import { describe, it, expect } from 'vitest'
import { podVerdict } from './podCheck.ts'
import type { BracketResult } from './bracketEngine.ts'

function fakeResult(overrides: {
  bracket: 2 | 3 | 4 | 5
  power: number
  gameChangers?: number
  fastMana?: number
  tutors?: number
  interaction?: number
  avgMv?: number
  combos?: number
}): BracketResult {
  return {
    bracket: overrides.bracket,
    bracketName: 'Test',
    powerScore: overrides.power,
    hardFlags:
      (overrides.gameChangers ?? 0) > 0
        ? [{ code: 'gameChangers', count: overrides.gameChangers!, message: `${overrides.gameChangers} Game Changers` }]
        : [],
    softSignals: {
      fastManaCount: overrides.fastMana ?? 0,
      tutorCount: overrides.tutors ?? 0,
      cheapInteractionCount: overrides.interaction ?? 5,
      avgManaValue: overrides.avgMv ?? 3.2,
      normalized: { fastMana: 0, tutors: 0, interaction: 0, curve: 0 },
    },
    flaggedCards: [],
    combos: Array.from({ length: overrides.combos ?? 0 }, (_, i) => ({
      cards: [`A${i}`, `B${i}`],
      combinedManaValue: 5,
      early: true,
    })),
    comboCheck: 'ok',
    gameChangersListVersion: 'test',
  }
}

describe('podVerdict', () => {
  it('is balanced when brackets match and power spread <= 2', () => {
    const v = podVerdict([
      fakeResult({ bracket: 3, power: 5.0 }),
      fakeResult({ bracket: 3, power: 6.2 }),
      fakeResult({ bracket: 3, power: 4.5 }),
    ])
    expect(v.balanced).toBe(true)
    expect(v.outlierIndex).toBeNull()
  })

  it('flags a bracket outlier and names its differentiators', () => {
    const v = podVerdict([
      fakeResult({ bracket: 2, power: 3.5 }),
      fakeResult({ bracket: 5, power: 9.5, gameChangers: 15, fastMana: 9, tutors: 10, avgMv: 2.1 }),
      fakeResult({ bracket: 2, power: 4.0 }),
    ])
    expect(v.balanced).toBe(false)
    expect(v.outlierIndex).toBe(1)
    expect(v.reasons.length).toBeGreaterThan(0)
    expect(v.reasons.length).toBeLessThanOrEqual(2)
  })

  it('flags a power-spread outlier within the same bracket', () => {
    const v = podVerdict([
      fakeResult({ bracket: 3, power: 4.0 }),
      fakeResult({ bracket: 3, power: 6.5, fastMana: 6 }),
    ])
    expect(v.balanced).toBe(false)
    expect(v.outlierIndex).toBe(1)
  })
})
