import { parseDecklist, detectCommanders } from './parser.ts'
import { fetchCards, type ScryfallCard } from './scryfall.ts'
import { normalizeDeck } from './normalizer.ts'
import { analyzeBracket, type BracketDeckEntry, type BracketResult } from './bracketEngine.ts'
import { HttpSpellbookClient } from './spellbook.ts'
import type { DeckEntry } from './parser.ts'
import type { Card } from '../types/card.ts'
import type { LocalCard } from './cardDatabase.ts'
import type { AnalysisResult } from './localEngine.ts'
import { analyze as analyzeLocal, analyzeCards, confidenceFor } from './localEngine.ts'
import { DEFAULT_FORMAT, type MtgFormat } from './formats.ts'

function toLocalCard(card: Card): LocalCard {
  const cats: string[] = []
  if (card.isRamp && !card.isLand) cats.push('ramp')
  if (card.isDraw) cats.push('draw')
  if (card.isRemoval) cats.push('removal')
  if (card.isCounterspell) cats.push('counter')
  if (card.isBoardWipe) cats.push('wipe')
  if (card.isLand) cats.push('land')
  if (card.isProtection) cats.push('protection')
  if (card.isWincon) cats.push('wincon')
  // Structural tags feeding the combat win-path detector.
  if (card.isCreature) cats.push('creature')
  if (card.isEvasive) cats.push('evasive')
  if (card.isCreature && (card.power ?? 0) >= 5) cats.push('big')
  if (card.isAuraOrEquipment) cats.push('boost')
  return {
    name: card.name,
    qty: card.qty,
    cmc: card.cmc,
    cost: card.mana_cost,
    type: card.type_line,
    cats,
    note: '',
  }
}

/** Match a commander name against normalized cards, front-face aware. */
function findCard(cards: Card[], name: string): Card | undefined {
  const lower = name.toLowerCase()
  return cards.find(
    (c) => c.name.toLowerCase() === lower || c.name.split(' // ')[0]?.toLowerCase() === lower,
  )
}

const spellbookClient = new HttpSpellbookClient()

/**
 * Pair raw decklist entries with their fetched Scryfall cards for the
 * bracket engine, honoring fuzzy/flavor-name aliases and front-face names.
 */
function toBracketEntries(
  entries: DeckEntry[],
  cards: ScryfallCard[],
  aliases: Record<string, string>,
  commanders: string[],
): BracketDeckEntry[] {
  const byName = new Map<string, ScryfallCard>()
  for (const card of cards) {
    byName.set(card.name.toLowerCase(), card)
    const front = card.name.split(' // ')[0]
    if (front !== undefined) byName.set(front.toLowerCase(), card)
  }
  const commanderSet = new Set(commanders.map((n) => n.toLowerCase()))
  return entries.map((e) => {
    const lower = e.name.toLowerCase()
    const canonical = aliases[lower]?.toLowerCase() ?? lower
    return {
      name: e.name,
      quantity: e.qty,
      scryfallData: byName.get(canonical),
      isCommander: commanderSet.has(lower),
    }
  })
}

async function tryAnalyzeBracket(bracketEntries: BracketDeckEntry[]): Promise<BracketResult | undefined> {
  try {
    return await analyzeBracket(bracketEntries, { spellbook: spellbookClient })
  } catch {
    // Bracket data is a bonus layer on top of the health score — never let it
    // break the core analysis.
    return undefined
  }
}

export interface PodDeckAnalysis {
  commanders: string[]
  commanderImage: string | null
  bracket: BracketResult
}

/**
 * Bracket-only pipeline for Pod Check: parse → Scryfall → bracket engine,
 * without the health-score machinery. Throws on fetch failure — the pod page
 * reports per-deck errors instead of falling back to the offline engine
 * (a bracket computed from the tiny fallback DB would be misleading).
 */
export async function runBracketCheck(text: string): Promise<PodDeckAnalysis> {
  const entries = parseDecklist(text)
  const fetched = await fetchCards(entries)
  const commanders = detectCommanders(text)
  const bracket = await analyzeBracket(
    toBracketEntries(entries, fetched.cards, fetched.aliases, commanders),
    { spellbook: spellbookClient },
  )
  const firstCommander = commanders[0]?.toLowerCase()
  const cmdCard =
    firstCommander === undefined
      ? undefined
      : fetched.cards.find(
          (c) =>
            c.name.toLowerCase() === firstCommander ||
            c.name.split(' // ')[0]?.toLowerCase() === firstCommander,
        )
  return {
    commanders,
    commanderImage: cmdCard?.image_uris?.normal ?? cmdCard?.card_faces?.[0]?.image_uris?.normal ?? null,
    bracket,
  }
}

export async function runAnalysis(text: string, format: MtgFormat = DEFAULT_FORMAT): Promise<AnalysisResult> {
  const entries = parseDecklist(text)
  let fetched: Awaited<ReturnType<typeof fetchCards>>
  try {
    fetched = await fetchCards(entries)
  } catch {
    return analyzeLocal(text, format)
  }
  const { cards, unresolved } = normalizeDeck(entries, fetched.cards, fetched.aliases)
  const localCards = cards.map(toLocalCard)

  const commanders = detectCommanders(text)
  // Color identity derived from ALL commanders (partners/backgrounds), used
  // to gate every downstream suggestion.
  const colorIdentity = [
    ...new Set(commanders.flatMap((name) => findCard(cards, name)?.color_identity ?? [])),
  ]

  const unknown = unresolved.map((e) => ({ name: e.name, qty: e.qty }))

  const confidence = confidenceFor(
    localCards.reduce((s, c) => s + c.qty, 0),
    unknown.reduce((s, c) => s + c.qty, 0),
    false,
  )

  const result = analyzeCards(localCards, unknown, commanders, colorIdentity, format, confidence)

  if (format.isCommander) {
    result.bracket = await tryAnalyzeBracket(
      toBracketEntries(entries, fetched.cards, fetched.aliases, commanders),
    )
  }

  return result
}
