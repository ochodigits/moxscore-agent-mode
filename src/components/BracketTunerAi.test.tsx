import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AI_TUNE_PROMPT_VERSION, AI_TUNE_RESPONSE_SCHEMA } from '../lib/aiExplanationApi'
import { I18nProvider } from '../lib/i18n'

const mocks = vi.hoisted(() => ({ run: vi.fn(), explain: vi.fn(), feedback: vi.fn() }))
vi.mock('../lib/bracketTuner.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/bracketTuner')>()
  return { ...original, runBracketTuner: (...args: unknown[]) => mocks.run(...args) }
})
vi.mock('../lib/aiExplanationApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/aiExplanationApi')>()
  return {
    ...original,
    explainTunerSwaps: (...args: unknown[]) => mocks.explain(...args),
    submitAiExplanationFeedback: (...args: unknown[]) => mocks.feedback(...args),
  }
})

import { BracketTuner } from './BracketTuner'

const requestId = '123e4567-e89b-42d3-a456-426614174000'
const result = {
  targetBracket: 2 as const,
  swaps: [{ cut: 'Cancel', cutReason: 'Lower mana efficiency.', add: 'Arcane Denial', addEur: 1, role: 'counterspell' as const, owned: false, reasoning: 'Deterministic explanation.' }],
  resultingBracket: 2 as const, resultingPower: 4, achievable: true, totalMissingEur: 1, notes: [],
}
const aiResponse = {
  requestId, schemaVersion: AI_TUNE_RESPONSE_SCHEMA, promptVersion: AI_TUNE_PROMPT_VERSION,
  explanations: [{ pairIndex: 0, cut: 'Cancel', add: 'Arcane Denial', reasoning: 'Arcane Denial replaces Cancel while preserving the counterspell role.', source: 'provider' as const }],
  providerOutcome: 'success' as const, providerCalled: true, replayed: false, fallbackReason: null,
  quota: { monthlyLimit: 50, monthlyUsed: 1, monthlyRemaining: 49 }, budgetWarning: false,
}

function renderTuner(aiAccess?: { request: typeof fetch; monthlyLimit: number; monthlyRemaining: number }) {
  return render(<I18nProvider><BracketTuner decklist="1 Cancel" aiAccess={aiAccess} onHover={() => {}} onLeave={() => {}} /></I18nProvider>)
}

describe('BracketTuner Pro explanation affordance', () => {
  beforeEach(() => {
    mocks.run.mockResolvedValue(result)
    mocks.explain.mockResolvedValue(aiResponse)
    mocks.feedback.mockResolvedValue(undefined)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(requestId)
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

  it('does not render any AI control without the /api/me-derived capability', async () => {
    renderTuner()
    fireEvent.click(screen.getByRole('button', { name: 'Tune deck' }))
    await screen.findByText('Deterministic explanation.')
    expect(screen.queryByRole('button', { name: 'Explain exact swaps with Pro AI' })).not.toBeInTheDocument()
  })

  it('discloses the data boundary and applies prose only to exact deterministic pairs', async () => {
    const request = vi.fn<typeof fetch>()
    renderTuner({ request, monthlyLimit: 50, monthlyRemaining: 50 })
    fireEvent.click(screen.getByRole('button', { name: 'Tune deck' }))
    const button = await screen.findByRole('button', { name: 'Explain exact swaps with Pro AI' })
    expect(screen.getByText(/provider receives card names, role, cut reason, and target bracket—not the decklist/i)).toBeInTheDocument()
    fireEvent.click(button)
    await screen.findByText(aiResponse.explanations[0]!.reasoning)
    expect(mocks.explain).toHaveBeenCalledWith(request, requestId, result.swaps, 2)
    expect(screen.getByText('Pro AI explanation')).toBeInTheDocument()
  })

  it('reuses the bounded request id after an intentional failure', async () => {
    const request = vi.fn<typeof fetch>()
    mocks.explain.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(aiResponse)
    renderTuner({ request, monthlyLimit: 50, monthlyRemaining: 50 })
    fireEvent.click(screen.getByRole('button', { name: 'Tune deck' }))
    const button = await screen.findByRole('button', { name: 'Explain exact swaps with Pro AI' })
    fireEvent.click(button)
    await screen.findByText(/temporarily unavailable/i)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.explain).toHaveBeenCalledTimes(2))
    expect(mocks.explain.mock.calls.map((call) => call[1])).toEqual([requestId, requestId])
  })

  it('keeps the original deterministic explanation when the server falls back', async () => {
    const request = vi.fn<typeof fetch>()
    mocks.explain.mockResolvedValue({
      ...aiResponse,
      providerCalled: false,
      fallbackReason: 'switch_off',
      providerOutcome: 'fallback',
      explanations: [{ ...aiResponse.explanations[0]!, source: 'deterministic', reasoning: 'Server fallback template.' }],
    })
    renderTuner({ request, monthlyLimit: 50, monthlyRemaining: 50 })
    fireEvent.click(screen.getByRole('button', { name: 'Tune deck' }))
    const button = await screen.findByRole('button', { name: 'Explain exact swaps with Pro AI' })
    fireEvent.click(button)
    await screen.findByText(/provider path was unavailable or rejected/i)
    expect(screen.getByText('Deterministic explanation.')).toBeInTheDocument()
    expect(screen.queryByText('Server fallback template.')).not.toBeInTheDocument()
  })

  it('attaches the Pro explanation badge to cut/add pairs, not add-only rows', async () => {
    const mixed = {
      ...result,
      swaps: [
        {
          cut: null,
          cutReason: 'Deck under 100 — add high-impact card',
          add: 'Rhystic Study',
          addEur: 40,
          role: 'draw' as const,
          owned: false,
          reasoning: 'Add Rhystic Study to raise draw toward bracket 2.',
        },
        result.swaps[0]!,
      ],
    }
    mocks.run.mockResolvedValue(mixed)
    const request = vi.fn<typeof fetch>()
    renderTuner({ request, monthlyLimit: 50, monthlyRemaining: 50 })
    fireEvent.click(screen.getByRole('button', { name: 'Tune deck' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain exact swaps with Pro AI' }))
    await screen.findByText(aiResponse.explanations[0]!.reasoning)
    const addOnlyRow = screen.getByText('+ Rhystic Study').closest('li')
    const pairRow = screen.getByText('− Cancel').closest('li')
    expect(addOnlyRow).not.toBeNull()
    expect(pairRow).not.toBeNull()
    expect(within(addOnlyRow!).queryByText('Pro AI explanation')).not.toBeInTheDocument()
    expect(within(pairRow!).getByText('Pro AI explanation')).toBeInTheDocument()
    expect(mocks.explain).toHaveBeenCalledWith(request, requestId, [mixed.swaps[1]], 2)
  })

  it('does not offer feedback when post-provider storage could not complete the request', async () => {
    const request = vi.fn<typeof fetch>()
    mocks.explain.mockResolvedValue({
      ...aiResponse,
      providerCalled: true,
      fallbackReason: 'control_unavailable',
      providerOutcome: 'fallback',
      explanations: [{ ...aiResponse.explanations[0]!, source: 'deterministic', reasoning: 'Server fallback template.' }],
    })
    renderTuner({ request, monthlyLimit: 50, monthlyRemaining: 50 })
    fireEvent.click(screen.getByRole('button', { name: 'Tune deck' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Explain exact swaps with Pro AI' }))
    await screen.findByText(/provider path was unavailable or rejected/i)
    expect(screen.queryByLabelText('Explanation feedback')).not.toBeInTheDocument()
  })
})
