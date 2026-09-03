import type { Card, ManaCurve, SubScores, AnalysisResult } from '../types/card.ts'
import {
  formatParams,
  scoreRamp,
  scoreDraw,
  scoreInteraction,
  scoreBoardWipes,
  scoreProtection,
  scoreWincons,
  scoreCurve,
  scoreLands,
  composeScore,
} from './scoring.ts'
import { DEFAULT_FORMAT } from './formats.ts'

const KNOWN_WINCONS: ReadonlySet<string> = new Set([
  "Thassa's Oracle",
  'Jace, Wielder of Mysteries',
  'Laboratory Maniac',
  'Approach of the Second Sun',
  'Revel in Riches',
  'Hellkite Tyrant',
  'Mechanized Production',
  'Felidar Sovereign',
  'Test of Endurance',
  'Biovisionary',
  'Simic Ascendancy',
  "Azor's Elocutors",
  'Coalition Victory',
  'Helix Pinnacle',
  'Darksteel Reactor',
  'Barren Glory',
  'Near-Death Experience',
  'Epic Struggle',
  'Mortal Combat',
  'Aetherflux Reservoir',
  'Craterhoof Behemoth',
  'Exsanguinate',
  'Torment of Hailfire',
  'Triumph of the Hordes',
])

// ---------------------------------------------------------------------------
// Category detectors — exported so normalizer can call them
// ---------------------------------------------------------------------------

// Land-search ramp: "a basic land", "up to two basic land cards", but also
// typed searches with no "land" in them — "a Forest card" (Nature's Lore,
// Three Visits), "a Plains, Island, Swamp, or Mountain card" (Farseek),
// "up to two Forest cards" (Skyshroud Claim).
const LAND_SEARCH_RE =
  /search your library for (?:up to \w+ )?(?:a |an )?[\w'’, ]*(?:land|forest|plains|island|swamp|mountain) cards?/

// Ramp must produce mana (or lands) you can actually use proactively. A mana
// payout gated behind an attack / combat-damage / death trigger (Savage
// Ventmaw, Neheb) is not ramp by any practical definition — the mana arrives
// a turn later and only if the trigger connects.
const DELAYED_TRIGGER_RE = /^(?:whenever|when) [^.\n]*\b(?:attacks|deals combat damage|dies)\b/

export function isRamp(oracle: string, typeLine: string): boolean {
  const t = typeLine.toLowerCase()
  const lines = oracle.toLowerCase().split('\n')

  for (const line of lines) {
    const producesMana =
      line.includes('add {') ||
      /add (?:one|two|three|x) mana/.test(line) ||
      // Mana-producing enchantments (Utopia Sprawl, Wild Growth) hook the
      // land itself rather than adding mana directly.
      line.includes('adds an additional') ||
      line.includes('tapped for mana') ||
      /create[^.\n]*treasure token/.test(line) ||
      LAND_SEARCH_RE.test(line) ||
      /put [^.\n]*land cards? [^.\n]*onto the battlefield/.test(line)
    if (producesMana && !DELAYED_TRIGGER_RE.test(line.trim())) return true
  }

  return t.includes('artifact') && oracle.toLowerCase().includes('{t}: add')
}

export function isDraw(oracle: string): boolean {
  const o = oracle.toLowerCase()
  return (
    o.includes('draw a card') ||
    o.includes('draw two cards') ||
    o.includes('draw three cards') ||
    o.includes('draw x cards') ||
    /draw \d+ cards/.test(o) ||
    /draw cards equal to/.test(o) ||
    o.includes('whenever') && o.includes('draw a card') ||
    o.includes('investigate') ||
    o.includes('return a card') && o.includes('from your graveyard to your hand') ||
    o.includes('put') && o.includes('from your library into your hand')
  )
}

export function isRemoval(oracle: string): boolean {
  const o = oracle.toLowerCase()
  if (o.includes('destroy all') || o.includes('exile all')) return false
  return (
    o.includes('destroy target') ||
    o.includes('exile target') ||
    o.includes('return target') ||
    o.includes('damage to target creature') ||
    o.includes('damage to any target') ||
    o.includes('target creature gets') ||
    o.includes('target player sacrifices a creature') ||
    o.includes('target opponent sacrifices a creature')
  )
}

export function isCounterspell(oracle: string, typeLine: string): boolean {
  const o = oracle.toLowerCase()
  const t = typeLine.toLowerCase()
  return t.includes('instant') && o.includes('counter target')
}

export function isBoardWipe(oracle: string): boolean {
  const o = oracle.toLowerCase()
  return (
    o.includes('destroy all') ||
    o.includes('destroy each') ||
    o.includes('exile all creatures') ||
    o.includes('exile each creature') ||
    o.includes('each creature gets') ||
    o.includes('all creatures get') ||
    (o.includes('deals') && o.includes('damage to each creature')) ||
    o.includes('damage to all creatures') ||
    o.includes('return all creatures')
  )
}

export function isLand(typeLine: string): boolean {
  return typeLine.toLowerCase().includes('land')
}

// Protection means GRANTING resilience (Swiftfoot Boots, Heroic Intervention,
// Teferi's Protection, fogs) — not merely mentioning a keyword. Requiring a
// granting verb before hexproof/indestructible keeps board wipes that say
// "can't be regenerated" (Wrath of God) and self-hexproof beaters (Carnage
// Tyrant) out of this category.
export function isProtection(oracle: string): boolean {
  const o = oracle.toLowerCase()
  return (
    /\b(?:gains?|has|have|are|is) [^.\n]*\b(?:hexproof|indestructible|shroud|protection from)\b/.test(o) ||
    /\bphases? out\b/.test(o) ||
    o.includes('prevent all damage') ||
    o.includes('prevent all combat damage') ||
    /spells you control can't be countered/.test(o) ||
    /\bregenerate (?:target|each|it|this|enchanted|equipped)\b/.test(o)
  )
}

export function isWincon(name: string, oracle: string): boolean {
  if (KNOWN_WINCONS.has(name)) return true
  return oracle.toLowerCase().includes('you win the game')
}

export function isCreature(typeLine: string): boolean {
  return typeLine.toLowerCase().includes('creature')
}

const EVASION_KEYWORDS = ['flying', 'menace', 'trample', 'shadow', 'fear', 'intimidate', 'skulk', 'horsemanship']

export function isEvasive(oracle: string, typeLine: string, keywords: string[]): boolean {
  if (!isCreature(typeLine)) return false
  const kw = keywords.map((k) => k.toLowerCase())
  if (EVASION_KEYWORDS.some((e) => kw.includes(e))) return true
  const o = oracle.toLowerCase()
  return o.includes("can't be blocked") || EVASION_KEYWORDS.some((e) => new RegExp(`\\b${e}\\b`).test(o))
}

export function isAuraOrEquipment(typeLine: string): boolean {
  const t = typeLine.toLowerCase()
  return t.includes('aura') || t.includes('equipment')
}

/**
 * Combat win-path detector: a deck with a real board presence and a way to
 * push damage through wins by attacking — that is a legitimate win condition
 * even with zero combo pieces (voltron, aggro, go-wide enchantment decks).
 */
export function hasCombatWinPath(stats: {
  creatures: number
  evasive: number
  bigCreatures: number
  aurasAndEquipment: number
}): boolean {
  if (stats.creatures < 12) return false
  return stats.evasive >= 5 || stats.bigCreatures >= 6 || stats.aurasAndEquipment >= 8
}

// ---------------------------------------------------------------------------
// Mana curve
// ---------------------------------------------------------------------------

function cmcBucket(cmc: number): keyof ManaCurve {
  if (cmc >= 7) return '7+'
  const floored = Math.floor(cmc)
  if (floored >= 0 && floored <= 6) return floored as 0 | 1 | 2 | 3 | 4 | 5 | 6
  return '7+'
}

export function buildManaCurve(cards: Card[]): ManaCurve {
  const curve: ManaCurve = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, '7+': 0 }
  for (const card of cards) {
    if (card.isLand) continue
    const bucket = cmcBucket(card.cmc)
    curve[bucket] += card.qty
  }
  return curve
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

function computeAvgCmc(cards: Card[]): number {
  let totalCmc = 0
  let totalQty = 0
  for (const card of cards) {
    if (card.isLand) continue
    totalCmc += card.cmc * card.qty
    totalQty += card.qty
  }
  return totalQty === 0 ? 0 : totalCmc / totalQty
}

export function scoreDecklist(cards: Card[]): AnalysisResult {
  const sum = (filter: (c: Card) => boolean) => cards.filter(filter).reduce((s, c) => s + c.qty, 0)

  const landCount = sum((c) => c.isLand)
  const rampCount = sum((c) => c.isRamp && !c.isLand)
  // Lands (War Room, cycling lands) belong to the mana base, not the draw count.
  const drawCount = sum((c) => c.isDraw && !c.isLand)
  // Board wipes are their own category now — interaction is targeted answers.
  const interactionCount = sum((c) => c.isRemoval || c.isCounterspell)
  const boardWipeCount = sum((c) => c.isBoardWipe)
  const protectionCount = sum((c) => c.isProtection && !c.isLand)

  // Win conditions count DISTINCT cards (2 copies of one wincon is still one
  // path to victory), plus a combat win path when the board supports one.
  const distinctWincons = cards.filter((c) => c.isWincon).length
  const combatStats = {
    creatures: sum((c) => c.isCreature),
    evasive: sum((c) => c.isEvasive),
    bigCreatures: sum((c) => c.isCreature && (c.power ?? 0) >= 5),
    aurasAndEquipment: sum((c) => c.isAuraOrEquipment),
  }
  const winconCount = distinctWincons + (hasCombatWinPath(combatStats) ? 1 : 0)

  const avgCmc = computeAvgCmc(cards)
  const manaCurve = buildManaCurve(cards)

  // Delegates to the shared scoring module (scoring.ts) — Commander defaults,
  // with ideals adjusted to this deck's actual curve.
  const p = formatParams(DEFAULT_FORMAT, { avgCmc })
  const subScores: SubScores = {
    ramp: scoreRamp(rampCount, p.idealRamp),
    interaction: scoreInteraction(interactionCount, p.idealInteraction),
    draw: scoreDraw(drawCount, p.idealDraw),
    wipes: scoreBoardWipes(boardWipeCount, p.idealWipesMin, p.idealWipesMax),
    protection: scoreProtection(protectionCount, p.idealProtection),
    curve: scoreCurve(avgCmc, p.idealCmc),
    lands: scoreLands(landCount, p),
    wincons: scoreWincons(winconCount),
  }

  const healthScore = composeScore(subScores)

  return {
    cards,
    healthScore,
    subScores,
    manaCurve,
    landCount,
    rampCount,
    drawCount,
    interactionCount,
    boardWipeCount,
    protectionCount,
    winconCount,
    avgCmc,
  }
}
