import { describe, it, expect } from 'vitest'
import { formatParams, scoreBoardWipes, scoreProtection, WEIGHTS } from './scoring.ts'
import { DEFAULT_FORMAT } from './formats.ts'

describe('formatParams — curve-relative ideals', () => {
  const flat = formatParams(DEFAULT_FORMAT)

  it('uses the static Commander baselines when no curve is given', () => {
    expect(flat.idealRamp).toBe(10)
    expect(flat.idealLandPeak).toBe(37)
    expect(flat.idealLandMin).toBe(32)
    expect(flat.idealLandMax).toBe(40)
    expect(flat.curveRelative).toBe(false)
  })

  it('a low-curve deck needs less ramp and fewer lands', () => {
    const p = formatParams(DEFAULT_FORMAT, { avgCmc: 2.2 })
    expect(p.curveRelative).toBe(true)
    expect(p.idealRamp).toBeLessThan(flat.idealRamp)
    expect(p.idealLandPeak).toBeLessThan(flat.idealLandPeak)
  })

  it('a high-curve deck needs more ramp and more lands', () => {
    const p = formatParams(DEFAULT_FORMAT, { avgCmc: 4.2 })
    expect(p.idealRamp).toBeGreaterThan(flat.idealRamp)
    expect(p.idealLandPeak).toBeGreaterThan(flat.idealLandPeak)
  })

  it('curve adjustments stay within sane bounds even for extreme curves', () => {
    const low = formatParams(DEFAULT_FORMAT, { avgCmc: 0.5 })
    const high = formatParams(DEFAULT_FORMAT, { avgCmc: 8 })
    expect(low.idealRamp).toBeGreaterThanOrEqual(6)
    expect(high.idealRamp).toBeLessThanOrEqual(14)
    expect(low.idealLandPeak).toBeGreaterThanOrEqual(33)
    expect(high.idealLandPeak).toBeLessThanOrEqual(40)
  })

  it('a deck exactly at the baseline curve gets the baseline ideals', () => {
    const p = formatParams(DEFAULT_FORMAT, { avgCmc: 3.0 })
    expect(p.idealRamp).toBe(flat.idealRamp)
    expect(p.idealLandPeak).toBe(flat.idealLandPeak)
  })

  it('scales ideals down for 60-card formats', () => {
    const experimentalSixtyCardFormat = {
      id: 'test-60',
      name: 'Test 60-card format',
      group: 'Test',
      deckLimit: 60,
      isCommander: false,
    }
    const p = formatParams(experimentalSixtyCardFormat)
    expect(p.idealRamp).toBeLessThan(flat.idealRamp)
    expect(p.idealLandPeak).toBeLessThan(flat.idealLandPeak)
  })
})

describe('scoreBoardWipes — a window, not a ladder', () => {
  it('penalizes zero wipes moderately', () => {
    expect(scoreBoardWipes(0, 2, 4)).toBe(30)
  })
  it('scores the recommended window at 100', () => {
    expect(scoreBoardWipes(2, 2, 4)).toBe(100)
    expect(scoreBoardWipes(4, 2, 4)).toBe(100)
  })
  it('penalizes too MANY wipes (self-defeating for creature decks)', () => {
    expect(scoreBoardWipes(6, 2, 4)).toBeLessThan(100)
    expect(scoreBoardWipes(8, 2, 4)).toBeLessThan(scoreBoardWipes(6, 2, 4))
  })
})

describe('scoreProtection', () => {
  it('is a simple count-vs-ideal ramp', () => {
    expect(scoreProtection(0, 4)).toBe(0)
    expect(scoreProtection(2, 4)).toBe(50)
    expect(scoreProtection(4, 4)).toBe(100)
    expect(scoreProtection(9, 4)).toBe(100)
  })
})

describe('WEIGHTS', () => {
  it('sums to exactly 1.0 across all eight categories', () => {
    const total = Object.values(WEIGHTS).reduce((s, w) => s + w, 0)
    expect(total).toBeCloseTo(1.0, 10)
  })
})
