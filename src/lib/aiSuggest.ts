// Client helper for the AI swap-suggestion endpoint (Pro tier).
// All AI calls happen server-side in /api/suggest — no provider key ever
// reaches the browser, and the server never reveals which provider answered.

import type { AnalysisResult } from './localEngine.ts'
import type { MtgFormat } from './formats.ts'

export interface AiSwap {
  category: string
  add: string
  cut?: string
  reason: string
}

export async function fetchAiSuggestions(
  decklist: string,
  result: AnalysisResult,
  format: MtgFormat,
  options: { aggressive?: boolean } = {},
): Promise<AiSwap[]> {
  const weakCategories = Object.entries(result.subScores)
    .filter(([, score]) => score < 70)
    .map(([key]) => key)

  const res = await fetch('/api/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decklist,
      commanders: result.commanders,
      colorIdentity: result.colorIdentity,
      format: format.id,
      subScores: result.subScores,
      counts: result.counts,
      weakCategories,
      aggressive: options.aggressive ?? false,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { suggestions?: AiSwap[]; error?: string }
  if (!res.ok || !Array.isArray(data.suggestions)) {
    throw new Error(data.error ?? 'AI suggestions are unavailable right now.')
  }
  return data.suggestions
}
