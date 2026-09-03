import { readFileSync } from 'node:fs'
import { corpus, CORPUS_VERSION, PROMPT_VERSION, RUBRIC_VERSION } from '../evaluation/ai/corpus.v1.mjs'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function corpusSummary() {
  return {
    status: 'NOT_RUN', corpusVersion: CORPUS_VERSION, rubricVersion: RUBRIC_VERSION,
    promptVersion: PROMPT_VERSION, caseCount: corpus.length,
    tiers: Object.fromEntries(['precon', 'upgraded', 'high_power', 'cedh'].map((tier) => [tier, corpus.filter((item) => item.tier === tier).length])),
  }
}

const reviewPath = process.argv[2]
if (!reviewPath) {
  process.stdout.write(`${JSON.stringify(corpusSummary(), null, 2)}\n`)
  process.stdout.write('Provide an external JSONL review file to score a provider/model run. Raw output must remain outside Git.\n')
} else {
  let records
  try {
    records = readFileSync(reviewPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    fail('Evaluation review file is unreadable or contains invalid JSONL.')
    records = []
  }

  const byId = new Map(corpus.map((item) => [item.id, item]))
  const seen = new Set()
  let identityFailures = 0
  let relevancePasses = 0
  let hardReviewFailures = 0
  const scoreTotals = { rolePreservation: 0, factualSupport: 0, relevance: 0, clarity: 0 }
  const versions = new Set()

  for (const record of records) {
    const testCase = byId.get(record.caseId)
    if (!testCase || seen.has(record.caseId)) { identityFailures += 1; continue }
    seen.add(record.caseId)
    const explanations = record.filteredExplanations
    const exact = Array.isArray(explanations)
      && explanations.length === testCase.deterministicPairs.length
      && explanations.every((item, index) => item?.pairIndex === index
        && item?.cut === testCase.deterministicPairs[index]?.cut
        && item?.add === testCase.deterministicPairs[index]?.add)
    if (!exact || record.review?.pairFidelity !== true) identityFailures += 1

    const dimensions = ['rolePreservation', 'factualSupport', 'relevance', 'clarity']
    const scoresValid = dimensions.every((name) => Number.isInteger(record.review?.[name]) && record.review[name] >= 1 && record.review[name] <= 5)
    if (!scoresValid || record.review?.unsupportedClaimsPass !== true || record.review?.safetyProductTruthPass !== true) {
      hardReviewFailures += 1
      continue
    }
    for (const name of dimensions) scoreTotals[name] += record.review[name]
    if (record.review.relevance >= 4) relevancePasses += 1
    if (typeof record.modelVersion === 'string' && record.modelVersion.length <= 100) versions.add(record.modelVersion)
  }

  const reviewed = seen.size
  const relevancePercentage = reviewed === 0 ? 0 : Math.round((relevancePasses / reviewed) * 10_000) / 100
  const accepted = reviewed === corpus.length && identityFailures === 0 && hardReviewFailures === 0 && relevancePercentage >= 90
  const aggregate = {
    status: accepted ? 'PASS' : 'FAIL', corpusVersion: CORPUS_VERSION, rubricVersion: RUBRIC_VERSION,
    promptVersion: PROMPT_VERSION, modelVersions: [...versions].sort(), casesExpected: corpus.length,
    casesReviewed: reviewed, identityFailures, hardReviewFailures, relevancePasses, relevancePercentage,
    averageScores: Object.fromEntries(Object.entries(scoreTotals).map(([name, total]) => [name, reviewed === 0 ? 0 : Math.round((total / reviewed) * 100) / 100])),
    acceptance: { minimumRelevancePercentage: 90, maximumAcceptedInventedSubstitutions: 0 },
  }
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`)
  if (!accepted) process.exitCode = 1
}
