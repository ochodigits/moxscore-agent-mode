import type { LocalCard } from '../lib/cardDatabase.ts'
import type { AnalysisResult } from '../lib/localEngine.ts'
import type { AgentAnalysis, AgentCategory, AgentProposal, ProposeResult } from './types.ts'

interface Staple {
  name: string
  helps: AgentCategory
  colors: string[]
  budget: boolean
  reason: string
}

const STAPLES: Staple[] = [
  { name: 'Arcane Signet', helps: 'ramp', colors: [], budget: true, reason: '2-mana rock that fixes every color in the identity.' },
  { name: 'Sol Ring', helps: 'ramp', colors: [], budget: true, reason: 'Fast colorless mana; staple ramp for almost every list.' },
  { name: 'Mind Stone', helps: 'ramp', colors: [], budget: true, reason: 'Cheap rock that can cycle later.' },
  { name: "Wayfarer's Bauble", helps: 'ramp', colors: [], budget: true, reason: 'Colorless land-to-battlefield ramp.' },
  { name: 'Cultivate', helps: 'ramp', colors: ['G'], budget: true, reason: 'Puts a land into play and another in hand.' },
  { name: 'Rampant Growth', helps: 'ramp', colors: ['G'], budget: true, reason: 'Two-mana land search to hit land drops.' },
  { name: 'Fellwar Stone', helps: 'ramp', colors: [], budget: true, reason: 'Budget fixer that usually taps for a color you need.' },
  { name: 'Rhystic Study', helps: 'draw', colors: ['U'], budget: false, reason: 'Repeatable card advantage whenever opponents skip the tax.' },
  { name: 'Harmonize', helps: 'draw', colors: ['G'], budget: true, reason: 'Draw three at instant-speed-feeling sorcery rate.' },
  { name: "Night's Whisper", helps: 'draw', colors: ['B'], budget: true, reason: 'Two cards for two mana; efficient refill.' },
  { name: 'Phyrexian Arena', helps: 'draw', colors: ['B'], budget: true, reason: 'Extra card every upkeep for a small life tax.' },
  { name: 'Elemental Bond', helps: 'draw', colors: ['G'], budget: true, reason: 'Draws whenever a 3-power creature enters.' },
  { name: "Garruk's Uprising", helps: 'draw', colors: ['G'], budget: true, reason: 'Draw on 4-power creatures plus a trample anthem.' },
  { name: 'Faithless Looting', helps: 'draw', colors: ['R'], budget: true, reason: 'Cheap filter that also flashbacks.' },
  { name: 'Mentor of the Meek', helps: 'draw', colors: ['W'], budget: true, reason: 'Pays 1 to draw whenever a small creature enters.' },
  { name: 'Painful Truths', helps: 'draw', colors: ['B'], budget: true, reason: 'Converge draw that scales in 3+ colors.' },
  { name: 'Swords to Plowshares', helps: 'interaction', colors: ['W'], budget: true, reason: 'Exile a creature for one white.' },
  { name: 'Beast Within', helps: 'interaction', colors: ['G'], budget: true, reason: 'Green answers any permanent.' },
  { name: 'Chaos Warp', helps: 'interaction', colors: ['R'], budget: true, reason: 'Red answers any permanent, including indestructible.' },
  { name: 'Counterspell', helps: 'interaction', colors: ['U'], budget: true, reason: 'Hard counter at the classic rate.' },
  { name: 'Generous Gift', helps: 'interaction', colors: ['W'], budget: true, reason: 'White Beast Within for any permanent.' },
  { name: 'Feed the Swarm', helps: 'interaction', colors: ['B'], budget: true, reason: 'Black enchantment (and creature) removal.' },
  { name: 'Arcane Denial', helps: 'interaction', colors: ['U'], budget: true, reason: 'Soft counter that still trades up.' },
  { name: 'Preordain', helps: 'curve', colors: ['U'], budget: true, reason: 'One-mana filter that lowers average CMC.' },
  { name: 'Explore', helps: 'curve', colors: ['G'], budget: true, reason: 'Two mana: extra land drop plus a card.' },
  { name: 'Sakura-Tribe Elder', helps: 'curve', colors: ['G'], budget: true, reason: 'Two-mana ramp body that comes down early.' },
  { name: 'Rampant Growth', helps: 'curve', colors: ['G'], budget: true, reason: 'Cheap ramp that also pulls the curve down.' },
  { name: 'Mind Stone', helps: 'curve', colors: [], budget: true, reason: 'Two-mana rock; cheaper than another 6-drop.' },
  { name: 'Triumph of the Hordes', helps: 'wincons', colors: ['G'], budget: true, reason: 'Infect overrun that closes creature games.' },
  { name: 'Overwhelming Stampede', helps: 'wincons', colors: ['G'], budget: true, reason: 'Anthem overrun for a wide or midrange board.' },
  { name: 'Craterhoof Behemoth', helps: 'wincons', colors: ['G'], budget: false, reason: 'Classic creature finisher.' },
  { name: 'Terror of the Peaks', helps: 'wincons', colors: ['R'], budget: false, reason: 'Turns every subsequent creature into a burn spell.' },
  { name: "Hellkite Tyrant", helps: 'wincons', colors: ['R'], budget: false, reason: 'Artifact-theft alternate win.' },
]

function identityOk(staple: Staple, colors: string[]): boolean {
  if (colors.length === 0) return true
  return staple.colors.every((c) => colors.includes(c))
}

function inDeck(cards: LocalCard[], name: string): boolean {
  const lower = name.toLowerCase()
  return cards.some((card) => card.name.toLowerCase() === lower)
}

function pickAdds(
  weakest: AgentCategory[],
  cards: LocalCard[],
  colors: string[],
  budget: boolean,
): AgentProposal[] {
  const adds: AgentProposal[] = []
  const used = new Set<string>()
  const cats: AgentCategory[] = weakest.length > 0 ? weakest : ['draw', 'curve']
  const eligible = (staple: Staple) =>
    identityOk(staple, colors) &&
    (!budget || staple.budget) &&
    !inDeck(cards, staple.name) &&
    !used.has(staple.name.toLowerCase())

  for (let i = 0; i < 12 && adds.length < 3; i += 1) {
    const category = cats[i % cats.length]
    if (!category) break
    const staple = STAPLES.find((s) => s.helps === category && eligible(s))
    if (!staple) continue
    used.add(staple.name.toLowerCase())
    adds.push({ name: staple.name, reason: staple.reason, helps: staple.helps })
  }
  if (adds.length < 3) {
    for (const staple of STAPLES) {
      if (adds.length >= 3) break
      if (!eligible(staple)) continue
      used.add(staple.name.toLowerCase())
      adds.push({ name: staple.name, reason: staple.reason, helps: staple.helps })
    }
  }
  return adds.slice(0, 3)
}

function cutReason(card: LocalCard, helps: AgentCategory): string {
  if (helps === 'curve') {
    return `Mana value ${card.cmc} with little supporting role — cutting it lowers the curve.`
  }
  if (card.cats.length === 0) {
    return `No ramp/draw/interaction role detected; cutting frees a slot for a weaker category.`
  }
  return `High-cost ${card.cats.join('/')} card; swapping it addresses ${helps}.`
}

function pickCuts(
  cards: LocalCard[],
  commanders: string[],
  weakest: AgentCategory[],
): AgentProposal[] {
  const commanderSet = new Set(commanders.map((name) => name.toLowerCase()))
  const protectedCats = new Set<string>(weakest.filter((c) => c === 'draw' || c === 'ramp' || c === 'interaction' || c === 'wincons'))
  const candidates = cards
    .filter((card) => !commanderSet.has(card.name.toLowerCase()))
    .filter((card) => !card.cats.includes('land'))
    .filter((card) => card.qty > 0)
    .slice()

  const scored = candidates.map((card) => {
    const protectsWeak = card.cats.some((cat) => {
      if (protectedCats.has(cat)) return true
      return (cat === 'removal' || cat === 'wipe' || cat === 'counter') && protectedCats.has('interaction')
    })
    const uncategorized = card.cats.filter((c) => c !== 'creature' && c !== 'evasive' && c !== 'big' && c !== 'boost').length === 0
    let rank = card.cmc * 10
    if (uncategorized) rank += 40
    if (protectsWeak) rank -= 80
    if (card.cats.includes('wincon') && protectedCats.has('wincons')) rank -= 50
    return { card, rank }
  })
  scored.sort((a, b) => b.rank - a.rank)

  const helps = weakest[0] ?? 'curve'
  const cuts: AgentProposal[] = []
  const used = new Set<string>()
  for (const { card } of scored) {
    if (cuts.length >= 3) break
    const key = card.name.toLowerCase()
    if (used.has(key)) continue
    used.add(key)
    cuts.push({ name: card.name, reason: cutReason(card, helps), helps })
  }
  return cuts
}

export function proposeChangesFor(
  analysis: AgentAnalysis,
  engine: AnalysisResult,
  options: { focus?: string[]; budget?: 'any' | 'budget' } = {},
): ProposeResult {
  const focus = (options.focus ?? [])
    .map((name) => name.toLowerCase())
    .filter((name): name is AgentCategory =>
      name === 'ramp' || name === 'draw' || name === 'interaction' || name === 'curve' || name === 'wincons',
    )
  const ranked = (Object.entries(analysis.categories) as [AgentCategory, number][])
    .slice()
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name)
  const weakest = (focus.length > 0 ? focus : ranked).slice(0, 2)
  const budget = options.budget === 'budget'
  const colors = engine.colorIdentity
  const cuts = pickCuts(engine.entries, engine.commanders, weakest)
  const adds = pickAdds(weakest, engine.entries, colors, budget)
  const identityNote = colors.length === 0
    ? 'Commander color identity was unknown, so adds were not identity-gated.'
    : `Adds stay inside ${colors.join('')} identity.`
  return {
    overall: analysis.overall,
    weakest,
    cuts,
    adds,
    note: `Human approval required before apply_changes. ${identityNote}`,
  }
}
