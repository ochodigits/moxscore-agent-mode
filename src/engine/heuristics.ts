import type { LocalCard } from '../lib/cardDatabase.ts'

const LAND_NAME_RE =
  /\b(plains|island|swamp|mountain|forest|wastes|command tower|exotic orchard|path of ancestry|evolving wilds|terramorphic|guildgate|bounce land|temple of|triome|fetch|shock)\b/i

export function heuristicCard(name: string, qty: number): LocalCard {
  const n = name.toLowerCase()
  const cats: string[] = []
  let type = 'Unknown'
  let cmc = 4

  if (LAND_NAME_RE.test(n) || /\bland\b/i.test(n)) {
    cats.push('land')
    type = 'Land'
    cmc = 0
  }

  if (
    /signet|talisman|sol ring|mana crypt|mana vault|arcane signet|fellwar|mind stone|thought vessel|commander.?s sphere|chromatic lantern|cultivate|kodama|rampant growth|farseek|nature.?s lore|three visits|skyshroud|explosive vegetation|wayfarer|growing rite|birds of paradise|llanowar|dork|rock/.test(n)
  ) {
    cats.push('ramp')
  }

  if (
    /rhystic|phyrexian arena|harmonize|night.?s whisper|read the bones|painful truths|elemental bond|kindred discovery|ascendancy|garruk.?s uprising|shamanic|windfall|brainstorm|preordain|opt\b|divination|concentrate|guardian project/.test(n)
  ) {
    cats.push('draw')
  }

  if (
    /swords to plowshares|path to exile|beast within|chaos warp|generous gift|terminate|go for the throat|feed the swarm|counterspell|arcane denial|swan song|negate|dovin's veto|reality shift/.test(n)
  ) {
    cats.push('removal')
  }

  if (/wrath|blasphemous|toxic deluge|damnation|cyclonic rift|crux of fate|doomskar|blasphemous act/.test(n)) {
    cats.push('wipe')
  }

  if (
    /craterhoof|triumph of the hordes|exsanguinate|torment of hailfire|thassa.?s oracle|approach of the second sun|hellkite tyrant|overrun|overwhelming stampede/.test(n)
  ) {
    cats.push('wincon')
  }

  if (/greaves|swiftfoot|heroic intervention|teferi.?s protection|veil of summer|lightning greaves/.test(n)) {
    cats.push('protection')
  }

  if (/\bdragon\b/.test(n) || /hellkite|drake|wyrm/.test(n)) {
    type = 'Creature — Dragon'
    if (cmc === 4) cmc = 6
  }

  return {
    name,
    qty,
    cmc,
    cost: '',
    type,
    cats,
    note: 'name-heuristic fallback',
  }
}
