import { describe, expect, it } from 'vitest'
import { compareVersions, type SavedDeckVersion } from './versionComparison'

function version(number: number, snapshot: Record<string, unknown>): SavedDeckVersion {
  return {
    id: `version-${number}`,
    version_number: number,
    analysis_snapshot: snapshot,
    analyzer_version: 'v2-preview',
    curated_data_version: '2026-07-31',
    created_at: '2026-07-31T00:00:00Z',
  }
}

describe('version comparison', () => {
  it('calculates deterministic score, category, curve, bracket, and card changes', () => {
    const result = compareVersions(
      version(1, {
        score: 70, subScores: { ramp: 50, draw: 60 }, curve: { '2': 10, '3': 8 },
        bracket: { bracket: 3 }, entries: [{ name: 'Sol Ring', qty: 1 }, { name: 'Island', qty: 10 }],
      }),
      version(2, {
        score: 80, subScores: { ramp: 80, draw: 60 }, curve: { '2': 11, '3': 7 },
        bracket: { bracket: 4 }, entries: [{ name: 'Sol Ring', qty: 1 }, { name: 'Arcane Signet', qty: 1 }, { name: 'Island', qty: 9 }],
      }),
    )

    expect(result.scoreDelta).toBe(10)
    expect(result.subScoreDeltas).toEqual({ draw: 0, ramp: 30 })
    expect(result.curveDeltas).toEqual({ '2': 1, '3': -1 })
    expect(result.bracketDelta).toBe(1)
    expect(result.addedCards).toEqual([{ name: 'Arcane Signet', quantity: 1 }])
    expect(result.removedCards).toEqual([{ name: 'Island', quantity: 1 }])
  })

  it('keeps absent scores and brackets explicitly unknown rather than inventing a delta', () => {
    const result = compareVersions(version(1, {}), version(2, {}))
    expect(result.scoreDelta).toBeNull()
    expect(result.bracketDelta).toBeNull()
  })
})
