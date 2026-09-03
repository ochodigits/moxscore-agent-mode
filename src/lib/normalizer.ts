import type { DeckEntry } from './parser.ts'
import type { ScryfallCard } from './scryfall.ts'
import type { Card } from '../types/card.ts'
import {
  isRamp,
  isDraw,
  isRemoval,
  isCounterspell,
  isBoardWipe,
  isLand,
  isProtection,
  isWincon,
  isCreature,
  isEvasive,
  isAuraOrEquipment,
} from './analysis.ts'

export function normalizeCard(entry: DeckEntry, sc: ScryfallCard): Card {
  // Scryfall omits root-level oracle_text / mana_cost / image_uris on
  // double-faced and modal cards; the data lives in card_faces instead.
  const faces = sc.card_faces ?? []
  const front = faces[0]

  // Category detection reads ALL faces — a ramp back face is still ramp.
  const oracle =
    sc.oracle_text ?? faces.map((f) => f.oracle_text ?? '').filter(Boolean).join('\n')

  // Curve and land/spell classification use the FRONT face only: an MDFC
  // whose type_line reads "Instant // Land" (Valakut Awakening) is a spell in
  // hand, not a land, and its mana value is the front face's cost.
  const typeLine = front?.type_line ?? sc.type_line ?? ''
  const manaCost = sc.mana_cost ?? front?.mana_cost ?? ''
  const imageUri = sc.image_uris?.normal ?? front?.image_uris?.normal ?? null

  const rawPower = sc.power ?? front?.power
  const power = rawPower !== undefined && /^\d+$/.test(rawPower) ? parseInt(rawPower, 10) : null
  const keywords = sc.keywords ?? []

  return {
    id: sc.id,
    name: sc.name,
    qty: entry.qty,
    cmc: sc.cmc,
    mana_cost: manaCost,
    type_line: typeLine,
    colors: sc.colors ?? front?.colors ?? [],
    color_identity: sc.color_identity ?? [],
    oracle_text: oracle,
    power,
    keywords,
    usd: sc.prices.usd,
    eur: sc.prices.eur,
    set_name: sc.set_name,
    image_uri: imageUri,
    isRamp: isRamp(oracle, typeLine),
    isDraw: isDraw(oracle),
    isRemoval: isRemoval(oracle),
    isCounterspell: isCounterspell(oracle, typeLine),
    isBoardWipe: isBoardWipe(oracle),
    isLand: isLand(typeLine),
    isProtection: isProtection(oracle),
    isWincon: isWincon(sc.name, oracle),
    isCreature: isCreature(typeLine),
    isEvasive: isEvasive(oracle, typeLine, keywords),
    isAuraOrEquipment: isAuraOrEquipment(typeLine),
  }
}

export interface NormalizedDeck {
  cards: Card[]
  /** Entries that no fetched Scryfall card could be matched to. */
  unresolved: DeckEntry[]
}

export function normalizeDeck(
  entries: DeckEntry[],
  scryfallCards: ScryfallCard[],
  /** requested-name (lowercased) → canonical name, from flavor-name / fuzzy retries. */
  aliases: Record<string, string> = {},
): NormalizedDeck {
  const byName = new Map<string, ScryfallCard>()
  for (const sc of scryfallCards) {
    byName.set(sc.name.toLowerCase(), sc)
    // Moxfield/Arena exports use front-face names only ("Valakut Awakening")
    // while Scryfall returns the full double name ("Valakut Awakening //
    // Valakut Stoneforge") — index the front face so those imports resolve.
    const front = sc.name.split(' // ')[0]
    if (front && front !== sc.name) {
      const key = front.toLowerCase()
      if (!byName.has(key)) byName.set(key, sc)
    }
  }

  const cards: Card[] = []
  const unresolved: DeckEntry[] = []
  for (const entry of entries) {
    const key = entry.name.toLowerCase()
    // Alternate printed names (Secret Lair flavor names like "Lifelong
    // Friendship" → Eladamri's Call) resolve through the alias map.
    const canonical = aliases[key]
    const sc = byName.get(key) ?? (canonical !== undefined ? byName.get(canonical.toLowerCase()) : undefined)
    if (sc === undefined) {
      unresolved.push(entry)
      continue
    }
    cards.push(normalizeCard(entry, sc))
  }
  return { cards, unresolved }
}
