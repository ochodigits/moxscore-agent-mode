/**
 * Commander bracket engine — implements the rules matrix in BRACKET_RULES.md.
 *
 * Pure functions over Scryfall card data; every threshold and weight comes
 * from src/config/*.json and every card list from src/data/*.json. Tuning a
 * result means editing those files, never this module.
 */
import type { ScryfallCard } from './scryfall.ts'
import type { SpellbookClient } from './spellbook.ts'
import { isRemoval, isCounterspell } from './analysis.ts'
import gamechangers from '../data/gamechangers.json'
import mld from '../data/mld.json'
import extraTurns from '../data/extraTurns.json'
import fastMana from '../data/fastMana.json'
import tutors from '../data/tutors.json'
import bracketRules from '../config/bracketRules.json'
import weights from '../config/weights.json'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BracketDeckEntry {
  name: string
  quantity: number
  scryfallData?: ScryfallCard
  isCommander?: boolean
}

export type FlagReason =
  | 'gameChanger'
  | 'massLandDenial'
  | 'extraTurn'
  | 'earlyCombo'
  | 'lateCombo'
  | 'fastMana'
  | 'tutor'

export interface FlaggedCard {
  card: string
  reason: FlagReason
  detail: string
  /** Higher = cutting this card lowers the bracket/power more. Used to rank tuner cuts. */
  bracketImpact: number
}

export interface HardFlag {
  code: 'gameChangers' | 'massLandDenial' | 'extraTurns' | 'earlyCombos' | 'combos'
  count: number
  message: string
}

export interface SoftSignals {
  fastManaCount: number
  tutorCount: number
  cheapInteractionCount: number
  avgManaValue: number
  /** Normalized 0–1 contributions, pre-weighting — useful for pod-check deltas. */
  normalized: { fastMana: number; tutors: number; interaction: number; curve: number }
}

export interface ComboHit {
  cards: string[]
  combinedManaValue: number
  early: boolean
}

export interface BracketResult {
  /** 2–5. Bracket 1 (Exhibition) is a self-designation, never auto-assigned. */
  bracket: 2 | 3 | 4 | 5
  bracketName: string
  powerScore: number
  hardFlags: HardFlag[]
  softSignals: SoftSignals
  flaggedCards: FlaggedCard[]
  combos: ComboHit[]
  comboCheck: 'ok' | 'skipped' | 'failed'
  gameChangersListVersion: string
}

// ---------------------------------------------------------------------------
// List matching
// ---------------------------------------------------------------------------

interface ListCard {
  name: string
  oracleId: string
}

interface ListIndex {
  byOracleId: Set<string>
  byName: Set<string>
}

function buildIndex(cards: ListCard[]): ListIndex {
  return {
    byOracleId: new Set(cards.map((c) => c.oracleId)),
    byName: new Set(cards.flatMap((c) => [c.name.toLowerCase(), c.name.split(' // ')[0]!.toLowerCase()])),
  }
}

const GC_INDEX = buildIndex(gamechangers.cards)
const MLD_INDEX = buildIndex(mld.cards)
const XT_INDEX = buildIndex(extraTurns.cards)
const FAST_INDEX = buildIndex(fastMana.cards)
const TUTOR_INDEX = buildIndex(tutors.cards)

function inList(entry: BracketDeckEntry, index: ListIndex): boolean {
  const oracleId = entry.scryfallData?.oracle_id
  if (oracleId !== undefined && index.byOracleId.has(oracleId)) return true
  const names = [entry.name, entry.scryfallData?.name ?? entry.name]
  return names.some((n) => index.byName.has(n.toLowerCase()) || index.byName.has(n.split(' // ')[0]!.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Soft signals
// ---------------------------------------------------------------------------

function oracleTextOf(card: ScryfallCard): string {
  if (card.oracle_text !== undefined) return card.oracle_text
  return (card.card_faces ?? []).map((f) => f.oracle_text ?? '').join('\n')
}

function isLandCard(card: ScryfallCard): boolean {
  const front = card.type_line.split(' // ')[0]!
  return front.includes('Land')
}

function isCheapInteraction(card: ScryfallCard, maxMv: number): boolean {
  if (card.cmc > maxMv) return false
  const oracle = oracleTextOf(card)
  return isRemoval(oracle) || isCounterspell(oracle, card.type_line)
}

// ---------------------------------------------------------------------------
// Bracket rules
// ---------------------------------------------------------------------------

export interface BracketRule {
  name: string
  gameChangersMax: number | null
  massLandDenialMax: number | null
  extraTurnsMax: number | null
  twoCardCombosMax: number | null
  earlyTwoCardCombosMax: number | null
  powerBand: number[]
}

const RULES: Record<string, BracketRule> = bracketRules.brackets

/** The hard-rule thresholds for one bracket — the Bracket Tuner's contract. */
export function bracketRule(bracket: 2 | 3 | 4 | 5): BracketRule {
  return RULES[String(bracket)]!
}

const within = (count: number, max: number | null): boolean => max === null || count <= max

/** Impact scores used to rank cuts in the tuner — bigger = more bracket-defining. */
const IMPACT: Record<FlagReason, number> = {
  earlyCombo: 4,
  gameChanger: 3,
  massLandDenial: 3,
  extraTurn: 2,
  lateCombo: 2,
  fastMana: 1,
  tutor: 1,
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AnalyzeBracketOptions {
  /** Inject a mock in tests; omit to skip combo detection entirely. */
  spellbook?: SpellbookClient
}

export async function analyzeBracket(
  entries: BracketDeckEntry[],
  options: AnalyzeBracketOptions = {},
): Promise<BracketResult> {
  const withData = entries.filter((e) => e.scryfallData !== undefined)

  // --- hard-rule counts -----------------------------------------------------
  const gcCards = entries.filter((e) => inList(e, GC_INDEX))
  const mldCards = entries.filter((e) => inList(e, MLD_INDEX))
  const xtCards = entries.filter((e) => inList(e, XT_INDEX))
  const fastCards = entries.filter((e) => inList(e, FAST_INDEX))
  const tutorCards = entries.filter((e) => inList(e, TUTOR_INDEX))

  // --- combos ----------------------------------------------------------------
  let comboCheck: BracketResult['comboCheck'] = 'skipped'
  const combos: ComboHit[] = []
  if (options.spellbook !== undefined) {
    try {
      const found = await options.spellbook.findCombos({
        commanders: entries.filter((e) => e.isCommander === true).map((e) => e.name),
        main: entries.filter((e) => e.isCommander !== true).map((e) => e.name),
      })
      const mvByName = new Map<string, number>()
      for (const e of withData) {
        const card = e.scryfallData!
        mvByName.set(card.name.toLowerCase(), card.cmc)
        mvByName.set(e.name.toLowerCase(), card.cmc)
        mvByName.set(card.name.split(' // ')[0]!.toLowerCase(), card.cmc)
      }
      for (const names of found) {
        const combinedManaValue = names.reduce((sum, n) => sum + (mvByName.get(n.toLowerCase()) ?? 0), 0)
        combos.push({
          cards: names,
          combinedManaValue,
          early: combinedManaValue <= bracketRules.earlyComboMaxCombinedMV,
        })
      }
      comboCheck = 'ok'
    } catch {
      comboCheck = 'failed'
    }
  }
  const earlyCombos = combos.filter((c) => c.early)

  // --- minimal bracket satisfying hard rules ---------------------------------
  let hardMin: 2 | 3 | 4 | 5 = 5
  for (const b of [2, 3, 4, 5] as const) {
    const rule = RULES[String(b)]!
    if (
      within(gcCards.length, rule.gameChangersMax) &&
      within(mldCards.length, rule.massLandDenialMax) &&
      within(xtCards.length, rule.extraTurnsMax) &&
      within(combos.length, rule.twoCardCombosMax) &&
      within(earlyCombos.length, rule.earlyTwoCardCombosMax)
    ) {
      hardMin = b
      break
    }
  }

  // --- soft signals -----------------------------------------------------------
  const w = weights.signals
  const nonland = withData.filter((e) => !isLandCard(e.scryfallData!))
  const nonlandQty = nonland.reduce((s, e) => s + e.quantity, 0)
  const avgManaValue =
    nonlandQty === 0 ? 0 : nonland.reduce((s, e) => s + e.quantity * e.scryfallData!.cmc, 0) / nonlandQty
  const cheapInteraction = withData.filter((e) => isCheapInteraction(e.scryfallData!, w.interaction.cheapMvMax))

  const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
  const normalized = {
    fastMana: clamp01(fastCards.length / w.fastMana.saturation),
    tutors: clamp01(tutorCards.length / w.tutors.saturation),
    interaction: clamp01(cheapInteraction.length / w.interaction.saturation),
    curve: clamp01((w.curve.avgMvWorst - avgManaValue) / (w.curve.avgMvWorst - w.curve.avgMvBest)),
  }
  const weighted =
    normalized.fastMana * w.fastMana.weight +
    normalized.tutors * w.tutors.weight +
    normalized.interaction * w.interaction.weight +
    normalized.curve * w.curve.weight

  const b = weights.hardSignalBonuses
  const bonus = Math.min(
    b.maxTotalBonus,
    gcCards.length * b.perGameChanger +
      earlyCombos.length * b.perEarlyCombo +
      (combos.length - earlyCombos.length) * b.perLateCombo +
      xtCards.length * b.perExtraTurn +
      mldCards.length * b.perMassLandDenial,
  )
  const powerScore = Math.round(Math.min(10, Math.max(1, 1 + 9 * weighted + bonus)) * 10) / 10

  // --- power floor can only push the bracket up ------------------------------
  let softMin: 2 | 3 | 4 | 5 = 2
  const floors = bracketRules.powerBracketFloors
  if (powerScore >= floors['5']) softMin = 5
  else if (powerScore >= floors['4']) softMin = 4
  else if (powerScore >= floors['3']) softMin = 3
  const bracket = Math.max(hardMin, softMin) as 2 | 3 | 4 | 5

  // --- flags ------------------------------------------------------------------
  const hardFlags: HardFlag[] = []
  if (gcCards.length > 0)
    hardFlags.push({
      code: 'gameChangers',
      count: gcCards.length,
      message: `${gcCards.length} Game Changer${gcCards.length === 1 ? '' : 's'} (bracket 3 allows up to 3, brackets 1–2 allow none)`,
    })
  if (mldCards.length > 0)
    hardFlags.push({
      code: 'massLandDenial',
      count: mldCards.length,
      message: `${mldCards.length} mass land denial card${mldCards.length === 1 ? '' : 's'} (not allowed below bracket 4)`,
    })
  if (xtCards.length > 0)
    hardFlags.push({
      code: 'extraTurns',
      count: xtCards.length,
      message: `${xtCards.length} extra-turn card${xtCards.length === 1 ? '' : 's'}`,
    })
  if (earlyCombos.length > 0)
    hardFlags.push({
      code: 'earlyCombos',
      count: earlyCombos.length,
      message: `${earlyCombos.length} early two-card combo${earlyCombos.length === 1 ? '' : 's'} (combined mana value ≤ ${bracketRules.earlyComboMaxCombinedMV}) — pushes past bracket 3`,
    })
  else if (combos.length > 0)
    hardFlags.push({
      code: 'combos',
      count: combos.length,
      message: `${combos.length} two-card combo${combos.length === 1 ? '' : 's'} (late-game only — allowed in bracket 3)`,
    })

  const flaggedCards: FlaggedCard[] = []
  const flag = (cards: BracketDeckEntry[], reason: FlagReason, detail: (e: BracketDeckEntry) => string): void => {
    for (const e of cards) flaggedCards.push({ card: e.name, reason, detail: detail(e), bracketImpact: IMPACT[reason] })
  }
  flag(gcCards, 'gameChanger', () => `Game Changer (list ${gamechangers.listVersion})`)
  flag(mldCards, 'massLandDenial', () => 'Mass land denial')
  flag(xtCards, 'extraTurn', () => 'Extra turn spell')
  flag(fastCards, 'fastMana', () => 'Fast mana')
  flag(tutorCards, 'tutor', () => 'Tutor')
  for (const combo of combos) {
    for (const name of combo.cards) {
      flaggedCards.push({
        card: name,
        reason: combo.early ? 'earlyCombo' : 'lateCombo',
        detail: `Two-card combo with ${combo.cards.filter((c) => c !== name).join(' + ')} (combined MV ${combo.combinedManaValue})`,
        bracketImpact: IMPACT[combo.early ? 'earlyCombo' : 'lateCombo'],
      })
    }
  }
  flaggedCards.sort((a, b2) => b2.bracketImpact - a.bracketImpact || a.card.localeCompare(b2.card))

  return {
    bracket,
    bracketName: RULES[String(bracket)]!.name,
    powerScore,
    hardFlags,
    softSignals: {
      fastManaCount: fastCards.length,
      tutorCount: tutorCards.length,
      cheapInteractionCount: cheapInteraction.length,
      avgManaValue: Math.round(avgManaValue * 100) / 100,
      normalized,
    },
    flaggedCards,
    combos,
    comboCheck,
    gameChangersListVersion: gamechangers.listVersion,
  }
}
