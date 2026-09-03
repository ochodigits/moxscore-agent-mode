import { describe, expect, it, vi } from 'vitest'

import type { TunerSwap } from './bracketTuner'
import {
  AI_TUNE_PROMPT_VERSION,
  AI_TUNE_RESPONSE_SCHEMA,
  explainTunerSwaps,
  submitAiExplanationFeedback,
} from './aiExplanationApi'

const requestId = '123e4567-e89b-42d3-a456-426614174000'
const swaps: TunerSwap[] = [{
  cut: 'Cancel', cutReason: 'Lower mana efficiency.', add: 'Arcane Denial', addEur: 1, role: 'counterspell', owned: false, reasoning: 'deterministic',
}]

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    schemaVersion: AI_TUNE_RESPONSE_SCHEMA,
    promptVersion: AI_TUNE_PROMPT_VERSION,
    explanations: [{ pairIndex: 0, cut: 'Cancel', add: 'Arcane Denial', reasoning: 'Arcane Denial replaces Cancel.', source: 'provider' }],
    providerOutcome: 'success', providerCalled: true, replayed: false, fallbackReason: null,
    quota: { monthlyLimit: 50, monthlyUsed: 1, monthlyRemaining: 49 }, budgetWarning: false,
    ...overrides,
  }
}

describe('AI explanation browser boundary', () => {
  it('sends only deterministic pair facts and never the decklist', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody()), { status: 200 }))
    await explainTunerSwaps(request, requestId, swaps, 3)
    expect(request).toHaveBeenCalledWith('/api/tune', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({
      schemaVersion: 'moxscore.tune-explanations.request.v1', requestId,
      pairs: [{ cut: 'Cancel', add: 'Arcane Denial', facts: { role: 'counterspell', cutReason: 'Lower mana efficiency.', targetBracket: 3 } }],
    })
    expect(JSON.stringify(body)).not.toContain('decklist')
  })

  it('explains only pairs with both cut and add (skips add-only and cut-only)', async () => {
    const mixed: TunerSwap[] = [
      { cut: null, cutReason: 'Deck under 100 — add high-impact card', add: 'Rhystic Study', addEur: 40, role: 'draw', owned: false, reasoning: 'add-only' },
      { cut: 'Cancel', cutReason: 'Lower mana efficiency.', add: 'Arcane Denial', addEur: 1, role: 'counterspell', owned: false, reasoning: 'pair' },
      { cut: 'Sol Ring', cutReason: 'Fast mana', add: null, addEur: null, role: 'ramp', owned: false, reasoning: 'cut-only' },
    ]
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody()), { status: 200 }))
    await explainTunerSwaps(request, requestId, mixed, 3)
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
    expect(body.pairs).toEqual([
      { cut: 'Cancel', add: 'Arcane Denial', facts: { role: 'counterspell', cutReason: 'Lower mana efficiency.', targetBracket: 3 } },
    ])
  })

  it('throws when only add-only or cut-only swaps are present', async () => {
    const request = vi.fn()
    await expect(explainTunerSwaps(request, requestId, [
      { cut: null, cutReason: 'under 100', add: 'Rhystic Study', addEur: 40, role: 'draw', owned: false, reasoning: 'add-only' },
      { cut: 'Sol Ring', cutReason: 'Fast mana', add: null, addEur: null, role: 'ramp', owned: false, reasoning: 'cut-only' },
    ], 3)).rejects.toThrow(/No cut\/add pairs/)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    { explanations: [{ pairIndex: 0, cut: 'Cancel', add: 'Invented', reasoning: 'text', source: 'provider' }] },
    { promptVersion: 'unknown' },
    { providerCalled: 'yes' },
    { quota: { monthlyLimit: '50', monthlyUsed: 1, monthlyRemaining: 49 } },
  ])('rejects malformed or identity-changing responses %#', async (overrides) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody(overrides)), { status: 200 }))
    await expect(explainTunerSwaps(request, requestId, swaps, 3)).rejects.toThrow('response was invalid')
  })

  it('submits only bounded enum feedback fields', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await submitAiExplanationFeedback(request, requestId, 'down', 'unsupported')
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ requestId, rating: 'down', reasonCode: 'unsupported' })
  })
})
