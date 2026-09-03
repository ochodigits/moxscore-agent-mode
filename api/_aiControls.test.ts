import { describe, expect, it } from 'vitest'

import { aiBudgetWarning, aiCostControls, budgetPercentage, conservativeAiInputTokens, estimateAiCostMicros } from './_aiControls'

const configured = {
  MOXSCORE_AI_DAILY_BUDGET_MICROS: '100000',
  MOXSCORE_AI_MONTHLY_BUDGET_MICROS: '1000000',
  MOXSCORE_AI_CONCURRENCY_LIMIT: '3',
  MOXSCORE_AI_INPUT_COST_PER_MILLION_MICROS: '2000000',
  MOXSCORE_AI_OUTPUT_COST_PER_MILLION_MICROS: '8000000',
}

describe('AI cost controls', () => {
  it('fails closed when any owner decision is missing or inconsistent', () => {
    expect(aiCostControls({})).toBeNull()
    expect(aiCostControls({ ...configured, MOXSCORE_AI_CONCURRENCY_LIMIT: '' })).toBeNull()
    expect(aiCostControls({ ...configured, MOXSCORE_AI_DAILY_BUDGET_MICROS: '2000000' })).toBeNull()
  })

  it('derives a conservative reservation from configured rates and token caps', () => {
    const controls = aiCostControls(configured)
    expect(controls).toMatchObject({
      dailyBudgetMicros: 100000,
      monthlyBudgetMicros: 1000000,
      concurrencyLimit: 3,
      reservationMicros: 12400,
      maxInputTokens: 3000,
      providerLeaseSeconds: 60,
    })
  })

  it('uses UTF-8 bytes as a conservative provider-neutral input token ceiling', () => {
    expect(conservativeAiInputTokens('abc', 'é')).toBe(5)
    expect(conservativeAiInputTokens('system', 'user')).toBeGreaterThanOrEqual('systemuser'.length)
  })

  it('rounds measured provider cost upward and safely handles invalid counts', () => {
    const rates = { inputCostPerMillionMicros: 2_000_000, outputCostPerMillionMicros: 8_000_000 }
    expect(estimateAiCostMicros(1_001, 101, rates)).toBe(2_810)
    expect(estimateAiCostMicros(-1, Number.NaN, rates)).toBe(0)
  })

  it('warns at 80 percent and presents bounded percentages', () => {
    const controls = aiCostControls(configured)!
    expect(aiBudgetWarning({ allowed: true, reason: 'granted', daily_committed_micros: 79_999, monthly_committed_micros: 0, active_leases: 1 }, controls)).toBe(false)
    expect(aiBudgetWarning({ allowed: true, reason: 'granted', daily_committed_micros: 80_000, monthly_committed_micros: 0, active_leases: 1 }, controls)).toBe(true)
    expect(budgetPercentage(1, 3)).toBe(33.33)
    expect(budgetPercentage(12, 10)).toBe(100)
  })
})
