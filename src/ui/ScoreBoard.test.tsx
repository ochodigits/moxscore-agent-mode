import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAnalysis } from '../engine/types.ts'
import { ScoreBoard } from './ScoreBoard'

const analysis: AgentAnalysis = {
  commander: 'Test Commander',
  card_count: 100,
  overall: 64,
  categories: { ramp: 80, draw: 40, interaction: 70, curve: 60, wincons: 70 },
  counts: { ramp: 10, draw: 4, interaction: 12, lands: 36, avg_cmc: 3.4 },
  weaknesses: [{ category: 'draw', severity: 'high', detail: 'Need more draw.' }],
  unresolved: [],
  diagnosis: ['Need more draw.'],
}

describe('ScoreBoard score formatting', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows category, overall, delta, and diagnosis scores to two decimal places', () => {
    render(
      <ScoreBoard
        analysis={{
          ...analysis,
          overall: 64.28571428571429,
          categories: { ...analysis.categories, ramp: 64.28571428571429 },
          diagnosis: ['9 ramp pieces (target 8–12). Score 64.29.'],
        }}
        previousOverall={58.1}
      />,
    )

    expect(screen.getAllByText('64.29').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/64\.28571428571429/)).not.toBeInTheDocument()
    expect(screen.getByText('9 ramp pieces (target 8–12). Score 64.29.')).toBeInTheDocument()
    expect(screen.getByText(/Previous 58\.10 → current 64\.29/)).toBeInTheDocument()
    expect(screen.getByText(/\+?\s*6\.19/)).toBeInTheDocument()
  })
})
