import { describe, expect, it } from 'vitest'
import { formatScore, roundScore } from './formatScore.ts'

describe('formatScore', () => {
  it('rounds repeating floats to two decimal places', () => {
    expect(formatScore(64.28571428571429)).toBe('64.29')
  })

  it('keeps two decimals for whole scores', () => {
    expect(formatScore(62)).toBe('62.00')
    expect(formatScore(100)).toBe('100.00')
  })

  it('formats negative deltas with two decimals', () => {
    expect(formatScore(-3.5)).toBe('-3.50')
  })
})

describe('roundScore', () => {
  it('returns a number with at most two decimal places', () => {
    expect(roundScore(64.28571428571429)).toBe(64.29)
    expect(roundScore(62)).toBe(62)
  })
})
