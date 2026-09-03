import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { corpus } from '../evaluation/ai/corpus.v1.mjs'

let temporaryDirectory = null

function reviewRecords() {
  return corpus.map((testCase) => ({
    caseId: testCase.id,
    modelVersion: 'owner-approved-model-v1',
    filteredExplanations: testCase.deterministicPairs.map((pair, pairIndex) => ({ pairIndex, cut: pair.cut, add: pair.add, reasoning: 'Externally reviewed text.' })),
    review: {
      pairFidelity: true, rolePreservation: 5, factualSupport: 5, relevance: 4, clarity: 5,
      unsupportedClaimsPass: true, safetyProductTruthPass: true,
    },
  }))
}

function writeReview(records) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'moxscore-ai-eval-'))
  const path = join(temporaryDirectory, 'review.jsonl')
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

describe('AI aggregate evaluation runner', () => {
  afterEach(() => {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = null
  })

  it('passes 60 reviewed relevant cases with exact pair identity', () => {
    const output = execFileSync(process.execPath, ['scripts/run-ai-evaluation.mjs', writeReview(reviewRecords())], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toMatchObject({ status: 'PASS', casesReviewed: 60, identityFailures: 0, relevancePercentage: 100 })
    expect(output).not.toContain('Externally reviewed text')
  })

  it('fails the entire run for one invented accepted substitution', () => {
    const records = reviewRecords()
    records[0].filteredExplanations[0].add = 'Invented Substitute'
    const result = spawnSync(process.execPath, ['scripts/run-ai-evaluation.mjs', writeReview(records)], { cwd: process.cwd(), encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'FAIL', identityFailures: 1 })
  })
})
