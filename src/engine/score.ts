import { analyzeCards, confidenceFor, type AnalysisResult } from '../lib/localEngine.ts'
import { runAnalysis } from '../lib/scryfallEngine.ts'
import { DEFAULT_FORMAT } from '../lib/formats.ts'
import { formatScore, roundScore } from '../lib/formatScore.ts'
import { clamp100 } from '../lib/scoring.ts'
import { detectCommanders } from '../lib/parser.ts'
import { heuristicCard } from './heuristics.ts'
import type { AgentAnalysis, AgentCategories, AgentCategory, AgentWeakness } from './types.ts'

export const AGENT_WEIGHTS: Record<AgentCategory, number> = {
  ramp: 0.2,
  draw: 0.2,
  interaction: 0.2,
  curve: 0.2,
  wincons: 0.2,
}

function scoreWindow(count: number, min: number, max: number): number {
  if (count >= min && count <= max) return 100
  if (count < min) {
    if (min <= 0) return 100
    return clamp100(Math.round((count / min) * 100))
  }
  return clamp100(100 - (count - max) * 8)
}

function highCmcQty(result: AnalysisResult): number {
  return result.entries
    .filter((card) => !card.cats.includes('land') && card.cmc >= 5)
    .reduce((sum, card) => sum + card.qty, 0)
}

export function agentCategoriesFrom(result: AnalysisResult): AgentCategories {
  const interactionCount = result.counts.interaction + result.counts.wipes
  const high = highCmcQty(result)
  const landPart = scoreWindow(result.counts.lands, 35, 38)
  const cmcPart = result.subScores.curve
  const highPenalty = Math.min(22, Math.max(0, high - 20))
  return {
    ramp: clamp100(result.subScores.ramp),
    draw: clamp100(result.subScores.draw),
    interaction: scoreWindow(interactionCount, 10, 15),
    curve: clamp100(Math.round(0.7 * cmcPart + 0.3 * landPart - highPenalty)),
    wincons: clamp100(result.subScores.wincons),
  }
}

export function agentOverall(categories: AgentCategories): number {
  return clamp100(
    Math.round(
      categories.ramp * AGENT_WEIGHTS.ramp +
        categories.draw * AGENT_WEIGHTS.draw +
        categories.interaction * AGENT_WEIGHTS.interaction +
        categories.curve * AGENT_WEIGHTS.curve +
        categories.wincons * AGENT_WEIGHTS.wincons,
    ),
  )
}

function roundCategories(categories: AgentCategories): AgentCategories {
  return {
    ramp: roundScore(categories.ramp),
    draw: roundScore(categories.draw),
    interaction: roundScore(categories.interaction),
    curve: roundScore(categories.curve),
    wincons: roundScore(categories.wincons),
  }
}

function weaknessDetail(category: AgentCategory, result: AnalysisResult, score: number): string {
  const interactionCount = result.counts.interaction + result.counts.wipes
  const high = highCmcQty(result)
  const shown = formatScore(score)
  switch (category) {
    case 'ramp':
      return `${result.counts.ramp} ramp pieces (target 8–12). Score ${shown}.`
    case 'draw':
      return `${result.counts.draw} draw effects (target 8–12). Score ${shown}.`
    case 'interaction':
      return `${interactionCount} answers including wipes (target 10–15). Score ${shown}.`
    case 'curve':
      return `Average nonland CMC ${result.avgCmc.toFixed(2)} with ${result.counts.lands} lands and ${high} cards at 5+ mana. Score ${shown}.`
    case 'wincons':
      return `${result.counts.wincons} win conditions detected. Score ${shown}.`
  }
}

export function buildWeaknesses(result: AnalysisResult, categories: AgentCategories): AgentWeakness[] {
  const ranked = (Object.entries(categories) as [AgentCategory, number][])
    .slice()
    .sort((a, b) => a[1] - b[1])
  const out: AgentWeakness[] = []
  for (const [category, score] of ranked) {
    if (score >= 75) continue
    const severity = score < 50 ? 'high' : score < 65 ? 'high' : 'medium'
    out.push({ category, severity, detail: weaknessDetail(category, result, score) })
  }
  return out.slice(0, 4)
}

export function buildDiagnosis(result: AnalysisResult, categories: AgentCategories): string[] {
  const bullets = buildWeaknesses(result, categories).map((w) => w.detail)
  if (result.unknown.length > 0) {
    bullets.push(`${result.unknown.length} card name${result.unknown.length === 1 ? '' : 's'} did not resolve and used name heuristics.`)
  }
  if (bullets.length === 0) {
    bullets.push(
      `Counts look healthy: ${result.counts.ramp} ramp, ${result.counts.draw} draw, ${result.counts.interaction + result.counts.wipes} interaction, ${result.counts.lands} lands.`,
    )
  }
  return bullets.slice(0, 4)
}

export function enrichAnalysis(result: AnalysisResult): AnalysisResult {
  if (result.unknown.length === 0) return result
  const extra = result.unknown.map((u) => heuristicCard(u.name, u.qty))
  const recognized = result.entries.reduce((sum, card) => sum + card.qty, 0) + extra.reduce((sum, card) => sum + card.qty, 0)
  return analyzeCards(
    [...result.entries, ...extra],
    [],
    result.commanders,
    result.colorIdentity,
    DEFAULT_FORMAT,
    confidenceFor(recognized, 0, false),
  )
}

export function buildAgentSnapshot(result: AnalysisResult): AgentAnalysis {
  const scored = enrichAnalysis(result)
  const categories = agentCategoriesFrom(scored)
  const commanders = scored.commanders.length > 0 ? scored.commanders : []
  return {
    commander: commanders[0] ?? scored.commander ?? 'Unknown',
    card_count: scored.counts.total,
    overall: roundScore(agentOverall(categories)),
    categories: roundCategories(categories),
    counts: {
      ramp: scored.counts.ramp,
      draw: scored.counts.draw,
      interaction: scored.counts.interaction + scored.counts.wipes,
      lands: scored.counts.lands,
      avg_cmc: Math.round(scored.avgCmc * 100) / 100,
    },
    weaknesses: buildWeaknesses(scored, categories),
    unresolved: result.unknown.map((u) => u.name),
    diagnosis: buildDiagnosis(scored, categories),
  }
}

export interface AgentEngineResult {
  snapshot: AgentAnalysis
  result: AnalysisResult
}

/** Shared analyzer used by the Analyze button and the analyze_deck tool. */
export async function analyzeAgentDeck(text: string): Promise<AgentEngineResult> {
  const trimmed = text.trim()
  const result = await runAnalysis(trimmed)
  if (result.commanders.length === 0) {
    const detected = detectCommanders(trimmed)
    if (detected.length > 0) result.commanders = detected
  }
  return { snapshot: buildAgentSnapshot(result), result }
}
