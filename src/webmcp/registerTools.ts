import { analyzeDeck, applyChanges, proposeChanges, toToolJson } from '../state/deckStore.ts'
import type { ModelContext, ModelContextTool } from './modelContext.d.ts'

const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decklist: {
      type: 'string',
      description: 'Commander decklist text. If omitted, analyze the deck currently on the page.',
    },
  },
} as const

const PROPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    focus: {
      type: 'array',
      items: { type: 'string', enum: ['ramp', 'draw', 'interaction', 'curve', 'wincons'] },
      description: 'Optional category names to prioritize. Defaults to the weakest scores.',
    },
    budget: {
      type: 'string',
      enum: ['any', 'budget'],
      description: 'budget prefers commonly available staples. No price API is used.',
    },
  },
} as const

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cuts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Card names to remove. Only names explicitly listed are cut.',
    },
    adds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Card names to add. Only names explicitly listed are added.',
    },
    confirm: {
      type: 'boolean',
      description: 'Must be true. If false, the deck is not mutated.',
    },
  },
  required: ['cuts', 'adds', 'confirm'],
} as const

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export const AGENT_TOOLS = [
  {
    name: 'analyze_deck',
    description:
      'Analyze the current Commander decklist (or a provided list) and return health scores, category breakdown, card counts, and the top weaknesses. Use this before recommending changes.',
    inputSchema: ANALYZE_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async (input: Record<string, unknown> = {}) => {
      const decklist = typeof input.decklist === 'string' ? input.decklist : undefined
      return toToolJson(await analyzeDeck(decklist))
    },
  },
  {
    name: 'propose_changes',
    description:
      'Propose up to 3 cuts and 3 additions to improve the weakest categories of the current analyzed deck. Does not modify the deck. Human must approve before apply_changes.',
    inputSchema: PROPOSE_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async (input: Record<string, unknown> = {}) => {
      const focus = asStringArray(input.focus)
      const budget = input.budget === 'budget' || input.budget === 'any' ? input.budget : undefined
      return toToolJson(await proposeChanges({ focus: focus.length > 0 ? focus : undefined, budget }))
    },
  },
  {
    name: 'apply_changes',
    description:
      'Apply previously proposed or explicitly listed cuts and additions to the on-page deck, then re-analyze. Only apply names the user/agent explicitly accepts. Recalculate scores and update the UI.',
    inputSchema: APPLY_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true },
    execute: async (input: Record<string, unknown> = {}) => {
      return toToolJson(
        await applyChanges({
          cuts: asStringArray(input.cuts),
          adds: asStringArray(input.adds),
          confirm: input.confirm === true,
        }),
      )
    },
  },
] as const

/**
 * Register the three Agent Mode tools on the page.
 * Uses document.modelContext.registerTool, with navigator.modelContext as a fallback.
 */
export async function registerAgentTools(signal?: AbortSignal): Promise<{ ok: boolean; via: string | null }> {
  const tools = AGENT_TOOLS
  if (document.modelContext && typeof document.modelContext.registerTool === 'function') {
    const pageContext: ModelContext = document.modelContext
    for (const tool of tools) {
      await pageContext.registerTool(tool as unknown as ModelContextTool, { signal })
    }
    return { ok: true, via: 'document.modelContext' }
  }
  const navCtx = navigator.modelContext
  if (navCtx && typeof navCtx.registerTool === 'function') {
    for (const tool of tools) {
      await navCtx.registerTool(tool as unknown as ModelContextTool, { signal })
    }
    return { ok: true, via: 'navigator.modelContext' }
  }
  return { ok: false, via: null }
}
