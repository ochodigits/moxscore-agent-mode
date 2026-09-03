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

describe('ScoreBoard loading', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows a scoring status on the empty health card while loading', () => {
    render(<ScoreBoard analysis={null} previousOverall={null} loading />)

    const card = screen.getByRole('region', { name: 'Health dashboard' })
    expect(card).toHaveAttribute('aria-busy', 'true')
    expect(card).toHaveClass('is-loading')
    expect(screen.getByRole('status')).toHaveTextContent('Scoring deck…')
    expect(screen.queryByText(/Run Analyze/i)).not.toBeInTheDocument()
  })

  it('overlays scoring status on existing scores while re-analyzing', () => {
    render(<ScoreBoard analysis={analysis} previousOverall={58} loading />)

    const card = screen.getByRole('region', { name: 'Health dashboard' })
    expect(card).toHaveAttribute('aria-busy', 'true')
    expect(card).toHaveClass('is-loading', 'has-analysis')
    expect(screen.getByRole('status')).toHaveTextContent('Scoring deck…')
    expect(screen.getByText('64.00')).toBeInTheDocument()
    expect(screen.getByText('Deck health')).toBeInTheDocument()
  })

  it('keeps the idle placeholder when there is no analysis', () => {
    render(<ScoreBoard analysis={null} previousOverall={null} />)

    expect(screen.getByText(/Run Analyze \(or call analyze_deck\)/i)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Health dashboard' })).not.toHaveAttribute('aria-busy')
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
