/**
 * Bracket Tuner — "get me to bracket N".
 *
 * Contract (see BRACKET_RULES.md): the target is reached when ALL of the
 * target bracket's hard rules are satisfied AND the power score is inside the
 * target band. Everything in this Preview workflow, including its concise
 * explanations, is deterministic. A future C1-gated provider layer may
 * explain already-validated swaps, but it cannot decide or alter them.
 */
import { parseDecklist, detectCommanders } from './parser.ts'
import { fetchCards, type ScryfallCard } from './scryfall.ts'
import {
  analyzeBracket,
  bracketRule,
  type BracketDeckEntry,
  type BracketResult,
  type FlaggedCard,
} from './bracketEngine.ts'
import type { SpellbookClient } from './spellbook.ts'
import { HttpSpellbookClient } from './spellbook.ts'
import roleTags from '../config/roleTags.json'
import tunerConfig from '../config/tuner.json'
import gamechangers from '../data/gamechangers.json'
import fastMana from '../data/fastMana.json'
import tutors from '../data/tutors.json'
import extraTurns from '../data/extraTurns.json'
import mld from '../data/mld.json'
import type { FlagReason } from './bracketEngine.ts'

export type RoleTag = keyof typeof roleTags.tags
export type OwnershipMode = 'any' | 'prefer-owned' | 'owned-only'
export type TunerConfig = typeof tunerConfig
export const TUNER_CONFIG: TunerConfig = tunerConfig

export type TunerDirection = 'upgrade' | 'downgrade' | 'stable'

/** Decide upgrade / downgrade / stable from current bracket+power vs target band. */
export function detectTunerDirection(
  current: Pick<BracketResult, 'bracket' | 'powerScore'>,
  target: 2 | 3 | 4 | 5,
): TunerDirection {
  if (current.bracket < target) return 'upgrade'
  if (current.bracket > target) return 'downgrade'
  const band = bracketRule(target).powerBand
  const floor = band[0] ?? 0
  const ceiling = band[1] ?? 10
  if (current.powerScore < floor) return 'upgrade'
  if (current.powerScore > ceiling) return 'downgrade'
  return 'stable'
}

/** Cuts that must not be back-filled with a random “same role” card when tuning down. */
const CUT_ONLY_REASONS = new Set<FlagReason>(['gameChanger', 'tutor', 'fastMana'])

function buildNameIndex(cards: ReadonlyArray<{ name: string }>): Set<string> {
  return new Set(cards.map((card) => card.name.toLowerCase()))
}

const GC_NAMES = buildNameIndex(gamechangers.cards)
const FAST_NAMES = buildNameIndex(fastMana.cards)
const TUTOR_NAMES = buildNameIndex(tutors.cards)
const XT_NAMES = buildNameIndex(extraTurns.cards)
const MLD_NAMES = buildNameIndex(mld.cards)
const UNSAFE_ADD_NAMES = new Set<string>([...GC_NAMES, ...FAST_NAMES, ...TUTOR_NAMES, ...XT_NAMES, ...MLD_NAMES])

function isUnsafeReplacement(name: string): boolean {
  return UNSAFE_ADD_NAMES.has(name.trim().toLowerCase())
}

export type UpgradePackageKind = 'gameChanger' | 'tutor' | 'fastMana' | 'extraTurn' | 'massLandDenial'

const PACKAGE_NAMES: Record<UpgradePackageKind, Set<string>> = {
  gameChanger: GC_NAMES,
  tutor: TUTOR_NAMES,
  fastMana: FAST_NAMES,
  extraTurn: XT_NAMES,
  massLandDenial: MLD_NAMES,
}

const PACKAGE_IMPACT: Record<UpgradePackageKind | 'role', number> = {
  gameChanger: 5,
  extraTurn: 4,
  tutor: 3,
  massLandDenial: 3,
  fastMana: 2,
  role: 1,
}

const PACKAGE_ROLE: Record<UpgradePackageKind, RoleTag> = {
  gameChanger: 'wincon',
  extraTurn: 'wincon',
  tutor: 'tutor',
  fastMana: 'ramp',
  massLandDenial: 'boardwipe',
}

const PACKAGE_SOURCES: ReadonlyArray<{ kind: UpgradePackageKind; cards: ReadonlyArray<{ name: string }> }> = [
  { kind: 'gameChanger', cards: gamechangers.cards },
  { kind: 'extraTurn', cards: extraTurns.cards },
  { kind: 'tutor', cards: tutors.cards },
  { kind: 'fastMana', cards: fastMana.cards },
  { kind: 'massLandDenial', cards: mld.cards },
]

/** True when the target still has hard-rule headroom for one more card of this package. */
export function targetAllowsUpgradePackage(
  target: 2 | 3 | 4 | 5,
  kind: UpgradePackageKind,
  currentCount: number,
): boolean {
  const rule = bracketRule(target)
  const max =
    kind === 'gameChanger' ? rule.gameChangersMax
    : kind === 'massLandDenial' ? rule.massLandDenialMax
    : kind === 'extraTurn' ? rule.extraTurnsMax
    : null
  if (max === null) return true
  return currentCount < max
}

export interface TunerSwap {
  /** Null for add-only upgrades when the deck has free slots. */
  cut: string | null
  cutReason: string
  /** Null when the safest downward move is cut-only (GC / tutor / fast mana). */
  add: string | null
  addEur: number | null
  role: RoleTag
  owned: boolean
  reasoning: string
}

export interface TunerResult {
  targetBracket: 2 | 3 | 4 | 5
  swaps: TunerSwap[]
  /** Bracket the deck lands on after applying every swap. */
  resultingBracket: 2 | 3 | 4 | 5
  resultingPower: number
  achievable: boolean
  totalMissingEur: number
  notes: string[]
}

export interface TunerInput {
  decklist: string
  targetBracket: 2 | 3 | 4 | 5
  /** Max EUR per replacement card (Cardmarket prices — EUR is the default currency). */
  budgetEurPerCard: number
  /** Owned card names (collection import parses into this later). */
  collection?: string[]
  ownershipMode?: OwnershipMode
  /** Card names the player does not want suggested. */
  excludedCardNames?: string[]
}

const SCRYFALL_DELAY_MS = 120
const MAX_SOFT_CUTS = 8

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Step 1 — deterministic cut set
// ---------------------------------------------------------------------------

function excessCuts(flagged: FlaggedCard[], reason: FlaggedCard['reason'], max: number | null): FlaggedCard[] {
  if (max === null) return []
  const hits = flagged.filter((f) => f.reason === reason)
  // flaggedCards is already deterministically sorted (impact, then name);
  // cut from the top until we're at the allowed count.
  return hits.slice(0, Math.max(0, hits.length - max))
}

function comboCuts(result: BracketResult, target: 2 | 3 | 4 | 5, commanders: Set<string>): FlaggedCard[] {
  const rule = bracketRule(target)
  const cuts: FlaggedCard[] = []
  for (const combo of result.combos) {
    const forbidden = combo.early
      ? rule.earlyTwoCardCombosMax === 0
      : rule.twoCardCombosMax === 0
    if (!forbidden) continue
    // Break the combo by cutting one piece — never the commander.
    const cuttable = combo.cards.filter((c) => !commanders.has(c.toLowerCase()))
    const piece = cuttable.sort()[0] ?? null
    if (piece !== null) {
      cuts.push({
        card: piece,
        reason: combo.early ? 'earlyCombo' : 'lateCombo',
        detail: `Breaks the ${combo.cards.join(' + ')} combo`,
        bracketImpact: combo.early ? 4 : 2,
      })
    }
  }
  return cuts
}

// ---------------------------------------------------------------------------
// Role detection for a cut card (drives the replacement search)
// ---------------------------------------------------------------------------

function roleOf(card: ScryfallCard | undefined, cutReason?: FlagReason): RoleTag {
  if (cutReason === 'tutor') return 'tutor'
  if (cutReason === 'fastMana') return 'ramp'
  if (card === undefined) return 'draw'
  const oracle = (card.oracle_text ?? card.card_faces?.map((f) => f.oracle_text ?? '').join('\n') ?? '').toLowerCase()
  const typeLine = card.type_line.toLowerCase()
  // Known tutor list beats generic oracle matching (many tutors do not say "draw").
  if (TUTOR_NAMES.has(card.name.toLowerCase())) return 'tutor'
  for (const tag of roleTags.tagOrder as RoleTag[]) {
    const def = roleTags.tags[tag]
    if (def.typeLine.some((t) => typeLine.includes(t)) && def.oracle.length === 0) return tag
    if (def.typeLine.length > 0 && !def.typeLine.some((t) => typeLine.includes(t))) continue
    if (def.oracle.some((p) => new RegExp(p, 'i').test(oracle))) return tag
  }
  return 'draw'
}

// ---------------------------------------------------------------------------
// Step 2 — replacement pool (Scryfall search, deterministic ordering)
// ---------------------------------------------------------------------------

interface Candidate {
  name: string
  eur: number | null
}

interface ValidatedCandidate extends Candidate {
  card: ScryfallCard
}

async function findReplacement(
  role: RoleTag,
  colorIdentity: string[],
  budgetEur: number,
  exclude: Set<string>,
  excludeGameChangers: boolean,
  collection: Set<string>,
  ownershipMode: OwnershipMode,
): Promise<Candidate | null> {
  const identity = colorIdentity.length > 0 ? colorIdentity.join('') : 'c'
  const parts = [
    'f:commander',
    `id<=${identity}`,
    `eur<=${budgetEur}`,
    roleTags.tags[role].scryfallQuery,
    excludeGameChangers ? '-is:gamechanger' : '',
  ]
  const url = `https://api.scryfall.com/cards/search?order=edhrec&unique=cards&q=${encodeURIComponent(parts.filter(Boolean).join(' '))}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ name: string; prices?: { eur?: string | null } }> }
    const candidates: Candidate[] = (data.data ?? [])
      .filter((c) => typeof c.name === 'string' && !exclude.has(c.name.toLowerCase()))
      .filter((c) => !isUnsafeReplacement(c.name))
      .slice(0, 20)
      .map((c) => ({ name: c.name, eur: c.prices?.eur !== undefined && c.prices.eur !== null ? Number(c.prices.eur) : null }))
      .filter((candidate) => candidate.eur === null || (Number.isFinite(candidate.eur) && candidate.eur >= 0 && candidate.eur <= budgetEur))
    const allowed = ownershipMode === 'owned-only'
      ? candidates.filter((candidate) => collection.has(candidate.name.toLowerCase()))
      : candidates
    if (allowed.length === 0) return null
    // Prefer a card the user already owns; otherwise the most-played one.
    return ownershipMode === 'prefer-owned'
      ? allowed.find((candidate) => collection.has(candidate.name.toLowerCase())) ?? allowed[0]!
      : allowed[0]!
  } catch {
    return null
  }
}

function cardFromFetch(
  fetched: { cards: ScryfallCard[]; aliases: Record<string, string> },
  name: string,
): ScryfallCard | undefined {
  const canonical = fetched.aliases[name.toLowerCase()] ?? name
  const key = canonical.toLowerCase()
  return fetched.cards.find(
    (entry) => entry.name.toLowerCase() === key || entry.name.split(' // ')[0]!.toLowerCase() === key,
  )
}

function validateResolvedCard(
  candidate: Candidate,
  card: ScryfallCard | undefined,
  colorIdentity: string[],
  budgetEur: number,
  excludedNames: Set<string>,
  commanderNames: Set<string>,
): ValidatedCandidate | null {
  if (!card) return null
  const normalized = card.name.toLowerCase()
  if (excludedNames.has(normalized) || commanderNames.has(normalized)) return null
  if (card.legalities?.commander !== undefined && card.legalities.commander !== 'legal') return null
  const identity = new Set(colorIdentity)
  if ((card.color_identity ?? []).some((color) => !identity.has(color))) return null
  const resolvedPrice = card.prices.eur === null || card.prices.eur === undefined ? candidate.eur : Number(card.prices.eur)
  if (resolvedPrice !== null && (!Number.isFinite(resolvedPrice) || resolvedPrice < 0 || resolvedPrice > budgetEur)) return null
  return { name: card.name, eur: resolvedPrice, card }
}

async function resolveCandidate(
  candidate: Candidate,
  colorIdentity: string[],
  budgetEur: number,
  excludedNames: Set<string>,
  commanderNames: Set<string>,
): Promise<ValidatedCandidate | null> {
  // Search is only a candidate source. Resolve through the normal bounded
  // card-data boundary before any swap reaches the UI.
  const resolved = await fetchCards([{ name: candidate.name, qty: 1 }])
  return validateResolvedCard(
    candidate,
    cardFromFetch(resolved, candidate.name),
    colorIdentity,
    budgetEur,
    excludedNames,
    commanderNames,
  )
}

// ---------------------------------------------------------------------------
// Step 3 — deterministic reasoning
// ---------------------------------------------------------------------------

function templateReasoning(swap: { cut: string | null; add: string | null; role: RoleTag; cutReason: string }, target: number): string {
  if (swap.cut === null) {
    return `Add ${swap.add} to raise ${swap.role} toward bracket ${target}.`
  }
  if (swap.add === null) {
    return `Cut ${swap.cut} (${swap.cutReason}) with no replacement — filling the slot often reintroduces bracket ${target} power (tutors, fast mana, or Game Changers).`
  }
  return `Fills ${swap.cut}'s ${swap.role} slot with ${swap.add} at a power level appropriate for bracket ${target}.`
}

// ---------------------------------------------------------------------------
// Upgrade pass
// ---------------------------------------------------------------------------

interface UpgradeCandidate {
  name: string
  kind: UpgradePackageKind | 'role'
  impact: number
  role: RoleTag
  eur: number | null
  edhrecRank: number
}

function countNamed(entries: BracketDeckEntry[], names: Set<string>): number {
  return entries.reduce((sum, entry) => {
    const cardName = entry.name.toLowerCase()
    const printed = entry.scryfallData?.name.toLowerCase()
    if (names.has(cardName) || (printed !== undefined && names.has(printed))) return sum + entry.quantity
    return sum
  }, 0)
}

function hardRulesSatisfied(entries: BracketDeckEntry[], target: 2 | 3 | 4 | 5): boolean {
  const rule = bracketRule(target)
  const within = (count: number, max: number | null): boolean => max === null || count <= max
  return (
    within(countNamed(entries, GC_NAMES), rule.gameChangersMax)
    && within(countNamed(entries, MLD_NAMES), rule.massLandDenialMax)
    && within(countNamed(entries, XT_NAMES), rule.extraTurnsMax)
  )
}

function reachedUpgradeGoal(
  current: Pick<BracketResult, 'bracket' | 'powerScore'>,
  target: 2 | 3 | 4 | 5,
  slack: number,
): boolean {
  const band = bracketRule(target).powerBand
  const floor = band[0] ?? 0
  const ceiling = band[1] ?? 10
  return current.bracket === target && current.powerScore >= floor && current.powerScore <= ceiling + slack
}

function pickWeakCut(
  entries: BracketDeckEntry[],
  commanderSet: Set<string>,
  minCmc: number,
  protectedNames: Set<string>,
): BracketDeckEntry | null {
  const eligible = entries.filter((entry) => {
    const key = entry.name.toLowerCase()
    if (entry.isCommander === true || commanderSet.has(key)) return false
    if (UNSAFE_ADD_NAMES.has(key) || protectedNames.has(key)) return false
    const cmc = entry.scryfallData?.cmc
    if (cmc === undefined || cmc < minCmc) return false
    return true
  })
  const nonlands = eligible.filter((entry) => !(entry.scryfallData?.type_line ?? '').toLowerCase().includes('land'))
  const pool = nonlands.length > 0 ? nonlands : eligible
  pool.sort((a, b) => (b.scryfallData?.cmc ?? 0) - (a.scryfallData?.cmc ?? 0) || a.name.localeCompare(b.name))
  return pool[0] ?? null
}

function removeOne(entries: BracketDeckEntry[], name: string): BracketDeckEntry[] {
  const key = name.toLowerCase()
  let removed = false
  const next: BracketDeckEntry[] = []
  for (const entry of entries) {
    if (!removed && entry.name.toLowerCase() === key) {
      removed = true
      if (entry.quantity > 1) next.push({ ...entry, quantity: entry.quantity - 1 })
      continue
    }
    next.push(entry)
  }
  return next
}

interface TunerRunContext {
  input: TunerInput
  entries: Array<{ name: string; qty: number }>
  baseEntries: BracketDeckEntry[]
  analysis: BracketResult
  colorIdentity: string[]
  commanderSet: Set<string>
  collection: Set<string>
  ownershipMode: OwnershipMode
  byName: Map<string, ScryfallCard>
  notes: string[]
}

async function runUpgradePass(ctx: TunerRunContext): Promise<TunerResult> {
  const { input, entries, analysis, colorIdentity, commanderSet, collection, ownershipMode, notes } = ctx
  const byName = ctx.byName
  const cfg = TUNER_CONFIG.upgrade
  const target = input.targetBracket
  const exclude = new Set([
    ...entries.map((entry) => entry.name),
    ...(input.excludedCardNames ?? []),
  ].map((name) => name.trim().toLowerCase()).filter(Boolean))

  const simulate = async (deck: BracketDeckEntry[]): Promise<BracketResult> => {
    const remainingNames = new Set(deck.map((entry) => entry.name.toLowerCase()))
    const staticSpellbook: SpellbookClient = {
      findCombos: async () =>
        (analysis.combos ?? [])
          .filter((combo) => combo.cards.every((name) => remainingNames.has(name.toLowerCase()) || commanderSet.has(name.toLowerCase())))
          .map((combo) => combo.cards),
    }
    return analyzeBracket(deck, { spellbook: staticSpellbook })
  }

  const seed: UpgradeCandidate[] = []
  const seen = new Set<string>()
  for (const source of PACKAGE_SOURCES) {
    if (!targetAllowsUpgradePackage(target, source.kind, countNamed(ctx.baseEntries, PACKAGE_NAMES[source.kind]))) continue
    for (const card of source.cards) {
      const key = card.name.toLowerCase()
      if (seen.has(key) || exclude.has(key) || commanderSet.has(key)) continue
      seen.add(key)
      seed.push({
        name: card.name,
        kind: source.kind,
        impact: PACKAGE_IMPACT[source.kind],
        role: PACKAGE_ROLE[source.kind],
        eur: null,
        edhrecRank: 0,
      })
    }
  }

  const resolved = new Map<string, ValidatedCandidate>()
  const CHUNK = 40
  for (let i = 0; i < seed.length; i += CHUNK) {
    const chunk = seed.slice(i, i + CHUNK)
    const fetched = await fetchCards(chunk.map((candidate) => ({ name: candidate.name, qty: 1 })))
    for (const candidate of chunk) {
      const validated = validateResolvedCard(
        candidate,
        cardFromFetch(fetched, candidate.name),
        colorIdentity,
        input.budgetEurPerCard,
        exclude,
        commanderSet,
      )
      if (validated === null) continue
      if (ownershipMode === 'owned-only' && !collection.has(validated.name.toLowerCase())) continue
      resolved.set(validated.name.toLowerCase(), validated)
      byName.set(validated.name.toLowerCase(), validated.card)
    }
  }

  const excludeGameChangers = !targetAllowsUpgradePackage(target, 'gameChanger', countNamed(ctx.baseEntries, GC_NAMES))
  const upgradeRoles = (roleTags.tagOrder as RoleTag[]).filter((role) => role !== 'land')
  for (const [index, role] of upgradeRoles.entries()) {
    const found = await findReplacement(
      role,
      colorIdentity,
      input.budgetEurPerCard,
      exclude,
      excludeGameChangers,
      collection,
      ownershipMode,
    )
    if (found !== null) {
      const validated = await resolveCandidate(found, colorIdentity, input.budgetEurPerCard, exclude, commanderSet)
      if (validated !== null) {
        const key = validated.name.toLowerCase()
        if (!seen.has(key) && !exclude.has(key)) {
          seen.add(key)
          seed.push({
            name: validated.name,
            kind: 'role',
            impact: PACKAGE_IMPACT.role,
            role,
            eur: validated.eur,
            edhrecRank: index + 1,
          })
          resolved.set(key, validated)
          byName.set(key, validated.card)
        }
      }
    }
    await sleep(SCRYFALL_DELAY_MS)
  }

  seed.sort((a, b) => b.impact - a.impact || a.edhrecRank - b.edhrecRank || a.name.localeCompare(b.name))

  let working = ctx.baseEntries.map((entry) => ({ ...entry }))
  let slotsLeft = Math.max(0, 100 - working.reduce((sum, entry) => sum + entry.quantity, 0))
  let adds = 0
  let weakCuts = 0
  let current = analysis
  const addedThisRun = new Set<string>()
  const swaps: TunerSwap[] = []
  notes.push(`Upgrade mode: adding high-impact cards toward bracket ${target}.`)

  for (const candidate of seed) {
    if (adds >= cfg.maxAdds) break
    if (reachedUpgradeGoal(current, target, cfg.powerSlack)) break
    const key = candidate.name.toLowerCase()
    if (exclude.has(key)) continue
    if (candidate.kind !== 'role' && !targetAllowsUpgradePackage(target, candidate.kind, countNamed(working, PACKAGE_NAMES[candidate.kind]))) {
      continue
    }
    const validated = resolved.get(key)
    if (validated === undefined) continue

    let cutEntry: BracketDeckEntry | null = null
    let nextEntries: BracketDeckEntry[]
    if (slotsLeft > 0) {
      nextEntries = [...working, { name: validated.name, quantity: 1, scryfallData: validated.card, isCommander: false }]
    } else {
      if (weakCuts >= cfg.maxWeakCuts) break
      cutEntry = pickWeakCut(working, commanderSet, cfg.minWeakCutCmc, addedThisRun)
      if (cutEntry === null) break
      nextEntries = [
        ...removeOne(working, cutEntry.name),
        { name: validated.name, quantity: 1, scryfallData: validated.card, isCommander: false },
      ]
    }

    if (!hardRulesSatisfied(nextEntries, target)) continue
    const projected = await simulate(nextEntries)
    const ceiling = bracketRule(target).powerBand[1] ?? 10
    if (projected.powerScore > ceiling + cfg.powerSlack) continue
    if (projected.bracket > target) continue

    working = nextEntries
    current = projected
    exclude.add(key)
    addedThisRun.add(key)
    adds += 1
    if (cutEntry !== null) {
      weakCuts += 1
    } else {
      slotsLeft -= 1
    }
    const cutName = cutEntry?.name ?? null
    const cutReason = cutEntry === null
      ? 'Deck under 100 — add high-impact card'
      : 'Weak cut to free a slot for a higher-impact upgrade'
    swaps.push({
      cut: cutName,
      cutReason,
      add: validated.name,
      addEur: validated.eur,
      role: candidate.role,
      owned: collection.has(validated.name.toLowerCase()),
      reasoning: templateReasoning({
        cut: cutName,
        add: validated.name,
        role: candidate.role,
        cutReason,
      }, target),
    })
  }

  if (swaps.length === 0) {
    notes.push('No in-budget upgrades found that stay within the target bracket band.')
  }

  return {
    targetBracket: target,
    swaps,
    resultingBracket: current.bracket,
    resultingPower: current.powerScore,
    achievable: reachedUpgradeGoal(current, target, cfg.powerSlack),
    totalMissingEur: Math.round(swaps.filter((swap) => !swap.owned).reduce((sum, swap) => sum + (swap.addEur ?? 0), 0) * 100) / 100,
    notes,
  }
}

// ---------------------------------------------------------------------------
// The tuner
// ---------------------------------------------------------------------------

export async function runBracketTuner(
  input: TunerInput,
  spellbook: SpellbookClient = new HttpSpellbookClient(),
): Promise<TunerResult> {
  const entries = parseDecklist(input.decklist)
  const fetched = await fetchCards(entries)
  const commanders = detectCommanders(input.decklist)
  const commanderSet = new Set(commanders.map((n) => n.toLowerCase()))
  const collection = new Set((input.collection ?? []).map((n) => n.toLowerCase()))
  const ownershipMode = input.ownershipMode ?? 'prefer-owned'
  const notes: string[] = []

  const byName = new Map<string, ScryfallCard>()
  for (const card of fetched.cards) {
    byName.set(card.name.toLowerCase(), card)
    byName.set(card.name.split(' // ')[0]!.toLowerCase(), card)
  }
  const toBracketEntry = (e: { name: string; qty: number }): BracketDeckEntry => ({
    name: e.name,
    quantity: e.qty,
    scryfallData: byName.get((fetched.aliases[e.name.toLowerCase()] ?? e.name).toLowerCase()),
    isCommander: commanderSet.has(e.name.toLowerCase()),
  })

  const baseEntries = entries.map(toBracketEntry)
  const analysis = await analyzeBracket(baseEntries, { spellbook })
  const rule = bracketRule(input.targetBracket)
  const colorIdentity = [
    ...new Set(
      commanders.flatMap((n) => byName.get(n.toLowerCase())?.color_identity ?? []),
    ),
  ]

  const direction = detectTunerDirection(analysis, input.targetBracket)
  if (direction === 'stable') {
    return {
      targetBracket: input.targetBracket,
      swaps: [],
      resultingBracket: analysis.bracket,
      resultingPower: analysis.powerScore,
      achievable: true,
      totalMissingEur: 0,
      notes: ['Already within the target bracket band.'],
    }
  }
  if (direction === 'upgrade') {
    return runUpgradePass({
      input,
      entries,
      baseEntries,
      analysis,
      colorIdentity,
      commanderSet,
      collection,
      ownershipMode,
      byName,
      notes,
    })
  }

  // ---- Step 1: hard-rule cuts ------------------------------------------------
  const cutMap = new Map<string, FlaggedCard>()
  const addCut = (f: FlaggedCard): void => {
    if (!commanderSet.has(f.card.toLowerCase()) && !cutMap.has(f.card.toLowerCase())) {
      cutMap.set(f.card.toLowerCase(), f)
    }
  }
  excessCuts(analysis.flaggedCards, 'gameChanger', rule.gameChangersMax).forEach(addCut)
  excessCuts(analysis.flaggedCards, 'massLandDenial', rule.massLandDenialMax).forEach(addCut)
  excessCuts(analysis.flaggedCards, 'extraTurn', rule.extraTurnsMax).forEach(addCut)
  comboCuts(analysis, input.targetBracket, commanderSet).forEach(addCut)

  // ---- soft-signal cuts until the power score fits the target -----------------
  const simulate = async (cutNames: Set<string>): Promise<BracketResult> => {
    const remaining = baseEntries.filter((e) => !cutNames.has(e.name.toLowerCase()))
    const remainingNames = new Set(remaining.map((e) => e.name.toLowerCase()))
    const staticSpellbook: SpellbookClient = {
      findCombos: async () =>
        analysis.combos
          .filter((c) => c.cards.every((n) => remainingNames.has(n.toLowerCase()) || commanderSet.has(n.toLowerCase())))
          .map((c) => c.cards),
    }
    return analyzeBracket(remaining, { spellbook: staticSpellbook })
  }

  let simulated = await simulate(new Set(cutMap.keys()))
  const bandMax = rule.powerBand[1] ?? 10
  let softCuts = 0
  while (
    (simulated.bracket > input.targetBracket || simulated.powerScore > bandMax) &&
    softCuts < MAX_SOFT_CUTS
  ) {
    const next = simulated.flaggedCards.find(
      (f) =>
        (f.reason === 'fastMana' || f.reason === 'tutor') &&
        !cutMap.has(f.card.toLowerCase()) &&
        !commanderSet.has(f.card.toLowerCase()),
    )
    if (next === undefined) break
    addCut(next)
    softCuts += 1
    simulated = await simulate(new Set(cutMap.keys()))
  }

  const achievable = simulated.bracket <= input.targetBracket
  if (!achievable) {
    notes.push(
      'The target bracket is out of reach by swaps alone — the remaining power comes from the deck core (or its commander).',
    )
  }

  // ---- Step 2: replacements (or cut-only for high-power flags) ----------------
  const cuts = [...cutMap.values()].sort((a, b) => b.bracketImpact - a.bracketImpact || a.card.localeCompare(b.card))
  const exclude = new Set([
    ...entries.map((entry) => entry.name),
    ...(input.excludedCardNames ?? []),
  ].map((name) => name.trim().toLowerCase()).filter(Boolean))
  const excludeGameChangers = input.targetBracket <= 3
  const pairs: Array<{ cut: FlaggedCard; add: ValidatedCandidate | null; role: RoleTag }> = []
  for (const cut of cuts) {
    const role = roleOf(byName.get(cut.card.toLowerCase()), cut.reason)
    if (CUT_ONLY_REASONS.has(cut.reason)) {
      pairs.push({ cut, add: null, role })
      notes.push(`Cut ${cut.card} with no replacement (${cut.reason}) — a fill-in often restores bracket-breaking power.`)
      continue
    }
    const found = await findReplacement(role, colorIdentity, input.budgetEurPerCard, exclude, excludeGameChangers, collection, ownershipMode)
    let add = found === null ? null : await resolveCandidate(found, colorIdentity, input.budgetEurPerCard, exclude, commanderSet)
    if (add !== null && isUnsafeReplacement(add.name)) add = null
    if (add !== null) {
      exclude.add(add.name.toLowerCase())
      byName.set(add.name.toLowerCase(), add.card)
      pairs.push({ cut, add, role })
    } else {
      pairs.push({ cut, add: null, role })
      notes.push(`No safe in-budget ${role} replacement found for ${cut.card} — cut it with no fill-in.`)
    }
    await sleep(SCRYFALL_DELAY_MS)
  }

  const swaps: TunerSwap[] = pairs.map((p) => ({
    cut: p.cut.card,
    cutReason: p.cut.detail,
    add: p.add?.name ?? null,
    addEur: p.add?.eur ?? null,
    role: p.role,
    owned: p.add !== null && collection.has(p.add.name.toLowerCase()),
    reasoning: templateReasoning({
      cut: p.cut.card,
      add: p.add?.name ?? null,
      role: p.role,
      cutReason: p.cut.detail,
    }, input.targetBracket),
  }))

  const postSwapEntries: BracketDeckEntry[] = [
    ...baseEntries.filter((entry) => !cutMap.has(entry.name.toLowerCase())),
    ...pairs
      .filter((pair): pair is { cut: FlaggedCard; add: ValidatedCandidate; role: RoleTag } => pair.add !== null)
      .map((pair) => ({ name: pair.add.name, quantity: 1, scryfallData: pair.add.card, isCommander: false })),
  ]
  const postSwapNames = new Set(postSwapEntries.map((entry) => entry.name.toLowerCase()))
  const postSwapSpellbook: SpellbookClient = {
    findCombos: async () => analysis.combos
      .filter((combo) => combo.cards.every((name) => postSwapNames.has(name.toLowerCase()) || commanderSet.has(name.toLowerCase())))
      .map((combo) => combo.cards),
  }
  const finalAnalysis = await analyzeBracket(postSwapEntries, { spellbook: postSwapSpellbook })
  const targetBand = rule.powerBand
  const targetMinimum = targetBand[0] ?? 0
  const targetMaximum = targetBand[1] ?? 10
  const reachedTarget = finalAnalysis.bracket === input.targetBracket
    && finalAnalysis.powerScore >= targetMinimum
    && finalAnalysis.powerScore <= targetMaximum
  if (!reachedTarget && achievable) {
    notes.push('Validated swaps improve the deck, but the requested target bracket cannot be confirmed safely after recalculation.')
  }

  return {
    targetBracket: input.targetBracket,
    swaps,
    resultingBracket: finalAnalysis.bracket,
    resultingPower: finalAnalysis.powerScore,
    achievable: reachedTarget,
    totalMissingEur: Math.round(swaps.filter((s) => !s.owned).reduce((sum, s) => sum + (s.addEur ?? 0), 0) * 100) / 100,
    notes,
  }
}
