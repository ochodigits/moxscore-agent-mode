import { MOX_DB, lookupCard, type LocalCard } from './cardDatabase'
import type { BracketResult } from './bracketEngine.ts'
import { parseDecklist as parseEntries, detectCommanders } from './parser.ts'
import { DEFAULT_FORMAT, type MtgFormat } from './formats.ts'
import {
  WEIGHTS,
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
  type CategoryKey,
  type ScoringParams,
} from './scoring.ts'

export type { CategoryKey } from './scoring.ts'

export interface ParseResult {
  entries: LocalCard[]
  unknown: { name: string; qty: number }[]
  commanders: string[]
}

export type SubScores = Record<CategoryKey, number>

export interface Suggestion {
  key: string
  title: string
  body: string
  examples: string[]
  impact: number
  cutCandidates?: string[]
}

export interface AnalysisConfidence {
  level: 'high' | 'medium' | 'low'
  recognized: number
  unknown: number
  message: string
}

export interface DeckCounts {
  total: number
  lands: number
  ramp: number
  draw: number
  interaction: number
  wipes: number
  protection: number
  wincons: number
}

export interface AnalysisResult {
  entries: LocalCard[]
  unknown: { name: string; qty: number }[]
  commander: string | null
  commanders: string[]
  /** WUBRG letters derived from the commander(s); empty when unknown. */
  colorIdentity: string[]
  counts: DeckCounts
  avgCmc: number
  curve: Record<string, number>
  subScores: SubScores
  score: number
  /** The exact targets this deck was scored against (curve-adjusted). */
  params: ScoringParams
  groups: Record<CategoryKey, LocalCard[]>
  feedback: Record<CategoryKey, string>
  summary: string
  confidence: AnalysisConfidence
  suggestions: Suggestion[]
  has: (name: string) => boolean
  /**
   * Commander bracket estimate (see BRACKET_RULES.md). Only present when the
   * analysis ran with live Scryfall data — the offline fallback engine
   * cannot compute it.
   */
  bracket?: BracketResult
}

// ---------------------------------------------------------------------------
// Parsing (delegates to the single shared parser in parser.ts)
// ---------------------------------------------------------------------------

export function parseDecklist(text: string): ParseResult {
  const entries: LocalCard[] = []
  const unknown: { name: string; qty: number }[] = []

  for (const e of parseEntries(text)) {
    const canonical = lookupCard(e.name)
    const def = canonical !== undefined ? MOX_DB[canonical] : undefined
    if (canonical !== undefined && def !== undefined) {
      const existing = entries.find((x) => x.name === canonical)
      if (existing) {
        existing.qty += e.qty
      } else {
        entries.push({ name: canonical, qty: e.qty, ...def })
      }
    } else {
      unknown.push({ name: e.name, qty: e.qty })
    }
  }

  const commanders = detectCommanders(text).map((name) => lookupCard(name) ?? name)
  return { entries, unknown, commanders }
}

// ---------------------------------------------------------------------------
// Feedback copy (parameterized by format ideals)
// ---------------------------------------------------------------------------

const CURVE_NOTE = ' (target tuned to this deck’s curve)'

function rampFeedback(n: number, ideal: number, tuned: boolean) {
  const note = tuned ? CURVE_NOTE : ''
  if (n < Math.round(ideal * 0.5)) return `Only ${n} ramp spells — your deck will struggle to keep up on mana.`
  if (n < ideal) return `${n} ramp spells is a decent start; ${ideal}+ is the sweet spot${note}.`
  return `${n} ramp spells keeps you ahead on mana throughout the game.`
}
function drawFeedback(n: number, ideal: number) {
  if (n < Math.round(ideal * 0.5)) return `Only ${n} draw effects — you'll run out of cards quickly.`
  if (n < ideal) return `${n} draw effects is okay; aim for ${ideal}+ to sustain.`
  return `${n} draw effects gives you strong card advantage.`
}
function interactionFeedback(n: number, ideal: number) {
  if (n < Math.round(ideal * 0.5)) return `Only ${n} targeted answers — opponents' threats may go unanswered.`
  if (n < ideal) return `${n} targeted answers is a reasonable package.`
  return `${n} targeted answers gives you plenty of removal and counterplay.`
}
function wipesFeedback(n: number, min: number, max: number) {
  if (n === 0) return 'No board wipes — one well-timed sweeper can undo a runaway board.'
  if (n < min) return `${n} board wipe is a start; ${min}–${max} covers more situations.`
  if (n <= max) return `${n} board wipes is a healthy safety net.`
  return `${n} board wipes is a lot — sweeping your own board too often can hurt your game plan.`
}
function protectionFeedback(n: number, ideal: number) {
  if (n === 0) return 'No protection effects — your key pieces are exposed to targeted removal.'
  if (n < ideal) return `${n} protection effects helps; ${ideal}+ keeps your engine safe.`
  return `${n} protection effects keeps your threats resilient.`
}
function curveFeedback(avg: number, idealCmc: number) {
  const a = avg.toFixed(2)
  if (avg < 1.5) return `Very low curve (${a}). Fast and aggressive — make sure you have enough late-game.`
  if (avg <= idealCmc - 0.5) return `Efficient curve (${a}). Consistent and fast.`
  if (avg <= idealCmc + 0.5) return `Well-balanced curve (${a}). Hits the sweet spot.`
  if (avg <= idealCmc + 1.0) return `Slightly heavy curve (${a}). Make sure your ramp can keep up.`
  return `Heavy curve (${a}). You'll need strong ramp to cast spells consistently.`
}
function landFeedback(n: number, p: ScoringParams) {
  const note = p.curveRelative ? CURVE_NOTE : ''
  if (n < p.idealLandMin) return `${n} lands is dangerously low — expect frequent mana problems.`
  if (n < p.idealLandPeak - 1) return `${n} lands is lean; strong ramp can help compensate${note}.`
  if (n <= p.idealLandPeak + 1) return `${n} lands is the ideal range${note}.`
  if (n <= p.idealLandMax) return `${n} lands is slightly high but won't hurt consistency.`
  return `${n} lands is excessive — consider swapping a few for spells.`
}
function winconFeedback(n: number, viaCombat: boolean) {
  if (n === 0) return 'No identified win conditions. Add a clear path to victory.'
  if (viaCombat && n === 1) return 'Your creature base is a real combat win path — a backup plan never hurts.'
  if (n === 1) return 'One win condition found. A backup plan never hurts.'
  if (viaCombat) return `${n} paths to victory, including winning through combat.`
  return `${n} paths to victory — opponents will need to answer multiple threats.`
}
function scoreSummary(s: number) {
  if (s >= 90) return 'An excellently constructed deck.'
  if (s >= 75) return 'A well-built deck — minor tuning will push it further.'
  if (s >= 50) return 'A functional deck with room for improvement.'
  return 'This deck needs work across several categories.'
}

export function confidenceFor(recognized: number, unknown: number, usedFallback: boolean): AnalysisConfidence {
  const total = recognized + unknown
  const ratio = total === 0 ? 0 : recognized / total
  if (usedFallback) {
    return {
      level: 'low',
      recognized,
      unknown,
      message: 'Limited confidence: live card data was unavailable, so this used the built-in card database.',
    }
  }
  if (ratio >= 0.95) {
    return {
      level: 'high',
      recognized,
      unknown,
      message: 'High confidence: live card data recognized nearly every card.',
    }
  }
  if (ratio >= 0.8) {
    return {
      level: 'medium',
      recognized,
      unknown,
      message: 'Medium confidence: a few cards were not recognized, so the score may be slightly conservative.',
    }
  }
  return {
    level: 'low',
    recognized,
    unknown,
    message: 'Low confidence: many cards were not recognized. Check spelling or paste a cleaner export for a better score.',
  }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

interface ExampleCard {
  name: string
  /** WUBRG color identity of the example — [] means colorless / any deck. */
  colors: string[]
}

const SUGGEST_EXAMPLES: Record<string, ExampleCard[]> = {
  ramp: [
    { name: 'Arcane Signet', colors: [] },
    { name: 'Mind Stone', colors: [] },
    { name: "Wayfarer's Bauble", colors: [] },
    { name: 'Thought Vessel', colors: [] },
  ],
  draw: [
    { name: 'Harmonize', colors: ['G'] },
    { name: 'Windfall', colors: ['U'] },
    { name: 'Greed', colors: ['B'] },
    { name: 'Painful Truths', colors: ['B'] },
    { name: 'Faithless Looting', colors: ['R'] },
    { name: 'Mentor of the Meek', colors: ['W'] },
  ],
  interaction: [
    { name: 'Swords to Plowshares', colors: ['W'] },
    { name: 'Cyclonic Rift', colors: ['U'] },
    { name: 'Anguished Unmaking', colors: ['W', 'B'] },
    { name: 'Swan Song', colors: ['U'] },
    { name: 'Beast Within', colors: ['G'] },
    { name: 'Chaos Warp', colors: ['R'] },
  ],
  wipes: [
    { name: 'Wrath of God', colors: ['W'] },
    { name: 'Blasphemous Act', colors: ['R'] },
    { name: 'Toxic Deluge', colors: ['B'] },
    { name: 'Cyclonic Rift', colors: ['U'] },
    { name: 'Ezuri’s Predation', colors: ['G'] },
  ],
  protection: [
    { name: 'Swiftfoot Boots', colors: [] },
    { name: 'Heroic Intervention', colors: ['G'] },
    { name: "Teferi's Protection", colors: ['W'] },
    { name: 'Veil of Summer', colors: ['G'] },
  ],
  wincons: [
    { name: 'Approach of the Second Sun', colors: ['W'] },
    { name: 'Craterhoof Behemoth', colors: ['G'] },
    { name: 'Torment of Hailfire', colors: ['B'] },
    { name: 'Hellkite Tyrant', colors: ['R'] },
    { name: 'Thassa’s Oracle', colors: ['U'] },
  ],
}

/** Static example suggestions must never point outside the deck's colors. */
function examplesFor(key: string, colorIdentity: string[], has: (name: string) => boolean): string[] {
  const pool = SUGGEST_EXAMPLES[key] ?? []
  return pool
    .filter((e) => !has(e.name))
    .filter((e) => colorIdentity.length === 0 || e.colors.every((c) => colorIdentity.includes(c)))
    .slice(0, 4)
    .map((e) => e.name)
}

function findCutCandidates(localCards: LocalCard[], commanders: string[]): string[] {
  const commanderSet = new Set(commanders.map((c) => c.toLowerCase()))
  // Never suggest cutting the deck's own commander.
  const candidates = localCards.filter((c) => !commanderSet.has(c.name.toLowerCase()))
  const nonLands = candidates.filter((c) => !c.cats.includes('land'))
  const uncategorized = nonLands.filter((c) => c.cats.length === 0)
  uncategorized.sort((a, b) => b.cmc - a.cmc)
  if (uncategorized.length > 0) return uncategorized.slice(0, 3).map((c) => c.name)
  // fallback: highest-cmc non-key cards
  const nonKey = nonLands
    .filter((c) => !c.cats.includes('wincon'))
    .slice()
    .sort((a, b) => b.cmc - a.cmc)
  return nonKey.slice(0, 3).map((c) => c.name)
}

function buildSuggestions(
  r: Omit<AnalysisResult, 'suggestions'>,
  format: MtgFormat,
  params: ScoringParams,
): Suggestion[] {
  const out: Suggestion[] = []
  const atLimit = r.counts.total >= format.deckLimit
  const cuts = atLimit ? findCutCandidates(r.entries, r.commanders) : []

  const push = (key: CategoryKey | 'trim' | 'singleton', title: string, body: string, examples: string[] = []) => {
    const limitNote = atLimit ? ` Your list has ${format.deckLimit} cards — adding a card means cutting one.` : ''
    const weight = key in WEIGHTS ? WEIGHTS[key as CategoryKey] : 0
    const sub = key in WEIGHTS ? r.subScores[key as CategoryKey] : 0
    out.push({
      key,
      title,
      body: body + limitNote,
      examples,
      impact: weight * (100 - sub),
      cutCandidates: atLimit ? cuts : undefined,
    })
  }

  if (r.subScores.ramp < 100)
    push('ramp', 'Add more ramp',
      `You have ${r.counts.ramp} ramp spells; ${params.idealRamp} is the sweet spot for this deck's curve.`,
      examplesFor('ramp', r.colorIdentity, r.has))

  if (r.subScores.draw < 100)
    push('draw', 'Add card draw',
      `${r.counts.draw} draw effects detected; aim for ${params.idealDraw}+ so you never run out of action.`,
      examplesFor('draw', r.colorIdentity, r.has))

  if (r.subScores.interaction < 100)
    push('interaction', 'Pack more answers',
      `${r.counts.interaction} targeted answers. Removal and counterspells keep opposing threats in check.`,
      examplesFor('interaction', r.colorIdentity, r.has))

  if (r.subScores.wipes < 100)
    push('wipes',
      r.counts.wipes > params.idealWipesMax ? 'Trim a board wipe or two' : 'Add a board wipe',
      wipesFeedback(r.counts.wipes, params.idealWipesMin, params.idealWipesMax),
      r.counts.wipes > params.idealWipesMax ? [] : examplesFor('wipes', r.colorIdentity, r.has))

  if (r.subScores.protection < 100)
    push('protection', 'Protect your key pieces',
      protectionFeedback(r.counts.protection, params.idealProtection),
      examplesFor('protection', r.colorIdentity, r.has))

  if (r.subScores.curve < 90)
    push('curve',
      r.avgCmc > params.idealCmc ? 'Lower the curve' : 'Beef up the top end',
      r.avgCmc > params.idealCmc
        ? `Average cost is ${r.avgCmc.toFixed(2)} — trim expensive spells or lean harder on ramp.`
        : `Average cost is ${r.avgCmc.toFixed(2)} — a couple of heavy hitters add late-game reach.`)

  if (r.subScores.lands < 100)
    push('lands',
      r.counts.lands < params.idealLandPeak ? 'Add a land or two' : 'Trim lands',
      `${r.counts.lands} lands detected; ${params.idealLandPeak - 1}–${params.idealLandPeak + 1} fits this deck's curve.`)

  if (r.subScores.wincons < 100)
    push('wincons', 'Add a backup win condition',
      winconFeedback(r.counts.wincons, false),
      examplesFor('wincons', r.colorIdentity, r.has))

  // Singleton violations in Commander-style formats.
  if (format.isCommander) {
    const dupes = r.entries.filter(
      (c) => c.qty > 1 && !c.type.toLowerCase().includes('basic') && !c.cats.includes('land'),
    )
    if (dupes.length > 0) {
      out.unshift({
        key: 'singleton',
        title: 'Fix singleton violations',
        body: `${format.name} allows only one copy of each card besides basic lands. Duplicates: ${dupes
          .map((c) => `${c.name} ×${c.qty}`)
          .join(', ')}.`,
        examples: [],
        impact: 998,
      })
    }
  }

  // When over the deck limit, surface an explicit "trim your deck" suggestion at the top.
  if (r.counts.total > format.deckLimit) {
    const excess = r.counts.total - format.deckLimit
    out.unshift({
      key: 'trim',
      title: `Trim ${excess} card${excess === 1 ? '' : 's'}`,
      body: `This deck has ${r.counts.total} cards but ${format.deckLimit} is the limit for ${format.name}. Remove the extras to make it legal.`,
      examples: [],
      impact: 999,
      cutCandidates: findCutCandidates(r.entries, r.commanders),
    })
  }

  return out.sort((a, b) => b.impact - a.impact)
}

// ---------------------------------------------------------------------------
// Shared analysis core — the ONLY place counts become scores. Both the live
// Scryfall engine and this offline fallback feed LocalCards through here, so
// the two paths can never score the same deck differently.
// ---------------------------------------------------------------------------

export function analyzeCards(
  entries: LocalCard[],
  unknown: { name: string; qty: number }[],
  commanders: string[],
  colorIdentity: string[],
  format: MtgFormat,
  confidence: AnalysisConfidence,
): AnalysisResult {
  const has = (name: string) => entries.some((e) => e.name === name)
  const sum = (filter: (c: LocalCard) => boolean) => entries.filter(filter).reduce((s, c) => s + c.qty, 0)
  const isLand = (c: LocalCard) => c.cats.includes('land')

  // Combat win path: enough creatures plus a way to push damage through is a
  // legitimate win condition even with zero combo pieces.
  const combatWin =
    sum((c) => c.cats.includes('creature')) >= 12 &&
    (sum((c) => c.cats.includes('evasive')) >= 5 ||
      sum((c) => c.cats.includes('big')) >= 6 ||
      sum((c) => c.cats.includes('boost')) >= 8)

  // Win conditions count DISTINCT cards, not copies.
  const distinctWincons = entries.filter((c) => c.cats.includes('wincon')).length

  const counts: DeckCounts = {
    total: entries.reduce((s, c) => s + c.qty, 0) + unknown.reduce((s, c) => s + c.qty, 0),
    lands: sum(isLand),
    ramp: sum((c) => c.cats.includes('ramp') && !isLand(c)),
    // Lands (War Room, cycling lands) belong to the mana base, not draw.
    draw: sum((c) => c.cats.includes('draw') && !isLand(c)),
    // Interaction is targeted answers; board wipes are scored separately.
    interaction: sum((c) => ['removal', 'counter'].some((k) => c.cats.includes(k))),
    wipes: sum((c) => c.cats.includes('wipe')),
    protection: sum((c) => c.cats.includes('protection') && !isLand(c)),
    wincons: distinctWincons + (combatWin ? 1 : 0),
  }

  let totalCmc = 0
  let totalQty = 0
  const curve: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7+': 0 }
  for (const c of entries) {
    if (isLand(c)) continue
    totalCmc += c.cmc * c.qty
    totalQty += c.qty
    const bucket = c.cmc >= 7 ? '7+' : String(Math.max(0, Math.floor(c.cmc)))
    curve[bucket] = (curve[bucket] ?? 0) + c.qty
  }
  const avgCmc = totalQty === 0 ? 0 : totalCmc / totalQty

  // Curve-relative ideals: what counts as "enough" ramp/lands scales with
  // this deck's actual average mana value, not one flat number.
  const p = formatParams(format, { avgCmc })

  const subScores: SubScores = {
    ramp: scoreRamp(counts.ramp, p.idealRamp),
    draw: scoreDraw(counts.draw, p.idealDraw),
    interaction: scoreInteraction(counts.interaction, p.idealInteraction),
    wipes: scoreBoardWipes(counts.wipes, p.idealWipesMin, p.idealWipesMax),
    protection: scoreProtection(counts.protection, p.idealProtection),
    curve: scoreCurve(avgCmc, p.idealCmc),
    lands: scoreLands(counts.lands, p),
    wincons: scoreWincons(counts.wincons),
  }
  const score = composeScore(subScores)

  const groups: Record<CategoryKey, LocalCard[]> = {
    ramp: entries.filter((c) => c.cats.includes('ramp') && !isLand(c)),
    draw: entries.filter((c) => c.cats.includes('draw') && !isLand(c)),
    interaction: entries.filter((c) => ['removal', 'counter'].some((k) => c.cats.includes(k))),
    wipes: entries.filter((c) => c.cats.includes('wipe')),
    protection: entries.filter((c) => c.cats.includes('protection') && !isLand(c)),
    curve: entries.filter((c) => !isLand(c)).slice().sort((a, b) => a.cmc - b.cmc),
    lands: entries.filter(isLand),
    wincons: entries.filter((c) => c.cats.includes('wincon')),
  }

  const feedback: Record<CategoryKey, string> = {
    ramp: rampFeedback(counts.ramp, p.idealRamp, p.curveRelative),
    draw: drawFeedback(counts.draw, p.idealDraw),
    interaction: interactionFeedback(counts.interaction, p.idealInteraction),
    wipes: wipesFeedback(counts.wipes, p.idealWipesMin, p.idealWipesMax),
    protection: protectionFeedback(counts.protection, p.idealProtection),
    curve: curveFeedback(avgCmc, p.idealCmc),
    lands: landFeedback(counts.lands, p),
    wincons: winconFeedback(counts.wincons, combatWin),
  }

  const partial = {
    entries,
    unknown,
    commander: commanders[0] ?? null,
    commanders,
    colorIdentity,
    counts,
    avgCmc,
    curve,
    subScores,
    score,
    params: p,
    groups,
    feedback,
    summary: scoreSummary(score),
    confidence,
    has,
  }
  return { ...partial, suggestions: buildSuggestions(partial, format, p) }
}

/** WUBRG letters found in a mana cost string like "{2}{W}{U}". */
function colorsFromCost(cost: string): string[] {
  return [...new Set(cost.match(/[WUBRG]/g) ?? [])]
}

/** Offline fallback analysis using the built-in card database. */
export function analyze(text: string, format: MtgFormat = DEFAULT_FORMAT): AnalysisResult {
  const { entries, unknown, commanders } = parseDecklist(text)

  // Best-effort color identity from the built-in DB's mana costs.
  const colorIdentity = [
    ...new Set(
      commanders.flatMap((name) => {
        const def = MOX_DB[name]
        return def ? colorsFromCost(def.cost) : []
      }),
    ),
  ]

  const confidence = confidenceFor(
    entries.reduce((s, c) => s + c.qty, 0),
    unknown.reduce((s, c) => s + c.qty, 0),
    true,
  )
  return analyzeCards(entries, unknown, commanders, colorIdentity, format, confidence)
}
