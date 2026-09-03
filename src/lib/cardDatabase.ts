export interface LocalCard {
  name: string
  cmc: number
  cost: string
  type: string
  cats: string[]
  note: string
  qty: number
}

type CardDef = Omit<LocalCard, 'name' | 'qty'>
const c = (cmc: number, cost: string, type: string, cats: string[], note: string): CardDef =>
  ({ cmc, cost, type, cats, note })

export const MOX_DB: Record<string, CardDef> = {
  'The Ur-Dragon': c(9, '{4}{W}{U}{B}{R}{G}', 'Legendary Creature — Dragon Avatar', [], 'Eminence: your Dragon spells cost {1} less.'),
  'Sol Ring': c(1, '{1}', 'Artifact', ['ramp'], 'Tap: add two colorless mana.'),
  'Arcane Signet': c(2, '{2}', 'Artifact', ['ramp'], 'Tap: add one mana of any color in your commander identity.'),
  'Fellwar Stone': c(2, '{2}', 'Artifact', ['ramp'], 'Tap: add one mana an opponent could produce.'),
  'Chromatic Lantern': c(3, '{3}', 'Artifact', ['ramp'], 'Lands tap for any color.'),
  "Dragon's Hoard": c(3, '{3}', 'Artifact', ['ramp', 'draw'], 'Gold counters when Dragons enter; spend to draw.'),
  'Cultivate': c(3, '{2}{G}', 'Sorcery', ['ramp'], 'Search two basics — one tapped, one to hand.'),
  "Kodama's Reach": c(3, '{2}{G}', 'Sorcery — Arcane', ['ramp'], 'Search two basics — one tapped, one to hand.'),
  'Farseek': c(2, '{1}{G}', 'Sorcery', ['ramp'], 'Search a Plains, Island, Swamp, or Mountain.'),
  'Rampant Growth': c(2, '{1}{G}', 'Sorcery', ['ramp'], 'Search a basic land, tapped.'),
  'Three Visits': c(2, '{1}{G}', 'Sorcery', ['ramp'], 'Search a Forest, untapped.'),
  "Nature's Lore": c(2, '{1}{G}', 'Sorcery', ['ramp'], 'Search a Forest, untapped.'),
  'Skyshroud Claim': c(4, '{3}{G}', 'Sorcery', ['ramp'], 'Search two Forests, untapped.'),
  'Explosive Vegetation': c(4, '{3}{G}', 'Sorcery', ['ramp'], 'Search two basics, tapped.'),
  'Rhystic Study': c(3, '{2}{U}', 'Enchantment', ['draw'], 'Draw when opponents skip the tax.'),
  'Phyrexian Arena': c(3, '{1}{B}{B}', 'Enchantment', ['draw'], 'Extra card each upkeep for 1 life.'),
  'Elemental Bond': c(3, '{2}{G}', 'Enchantment', ['draw'], 'Draw when a 3+ power creature enters.'),
  'Kindred Discovery': c(5, '{3}{U}{U}', 'Enchantment', ['draw'], 'Draw per Dragon entering or attacking.'),
  'Temur Ascendancy': c(3, '{G}{U}{R}', 'Enchantment', ['draw'], 'Haste + draw on big creatures.'),
  "Garruk's Uprising": c(3, '{2}{G}', 'Enchantment', ['draw'], 'Trample + draw on 4+ power creatures.'),
  'Return of the Wildspeaker': c(5, '{4}{G}', 'Instant', ['draw'], 'Draw cards equal to greatest power.'),
  'Painful Truths': c(3, '{1}{B}{B}', 'Sorcery', ['draw'], 'Draw up to three for converge.'),
  'Shamanic Revelation': c(5, '{3}{G}{G}', 'Sorcery', ['draw'], 'Draw per creature; ferocious lifegain.'),
  'Harmonize': c(4, '{2}{G}{G}', 'Sorcery', ['draw'], 'Draw three cards.'),
  'Swords to Plowshares': c(1, '{W}', 'Instant', ['removal'], 'Exile target creature.'),
  'Path to Exile': c(1, '{W}', 'Instant', ['removal'], 'Exile target creature; they ramp.'),
  'Beast Within': c(3, '{2}{G}', 'Instant', ['removal'], 'Destroy any permanent; they get a Beast.'),
  'Chaos Warp': c(3, '{2}{R}', 'Instant', ['removal'], 'Shuffle away any permanent.'),
  'Counterspell': c(2, '{U}{U}', 'Instant', ['counter'], 'Counter target spell.'),
  'Wrath of God': c(4, '{2}{W}{W}', 'Sorcery', ['wipe'], 'Destroy all creatures. No regeneration.'),
  'Blasphemous Act': c(9, '{8}{R}', 'Sorcery', ['wipe'], '13 damage to each creature; cheap in a crowd.'),
  'Crux of Fate': c(5, '{3}{B}{B}', 'Sorcery', ['wipe'], 'Destroy all Dragons — or everything else.'),
  "Sarkhan's Unsealing": c(4, '{3}{R}', 'Enchantment', ['removal'], 'Big creatures bolt on entry.'),
  'Hellkite Tyrant': c(6, '{4}{R}{R}', 'Creature — Dragon', ['wincon'], 'Win at upkeep with 20+ artifacts.'),
  'Lathliss, Dragon Queen': c(6, '{4}{R}{R}', 'Legendary Creature — Dragon', [], 'Token per nontoken Dragon entering.'),
  'Terror of the Peaks': c(5, '{3}{R}{R}', 'Creature — Dragon', [], 'Damage equal to entering power.'),
  'Goldspan Dragon': c(5, '{3}{R}{R}', 'Legendary Creature — Dragon', [], 'Treasures worth double.'),
  'Old Gnawbone': c(7, '{4}{G}{G}{G}', 'Legendary Creature — Dragon', [], 'Treasures on combat damage.'),
  'Utvara Hellkite': c(8, '{6}{R}{R}', 'Creature — Dragon', [], '6/6 Dragon per attacking Dragon.'),
  'Scourge of Valkas': c(5, '{2}{R}{R}{R}', 'Creature — Dragon', [], 'Damage per Dragon entering.'),
  'Dragon Tempest': c(2, '{1}{R}', 'Enchantment', [], 'Haste + damage per Dragon entering.'),
  'Crucible of Fire': c(3, '{2}{R}', 'Enchantment', [], 'Dragons get +3/+3.'),
  'Dragonlord Atarka': c(7, '{5}{R}{G}', 'Legendary Creature — Elder Dragon', ['removal'], '5 damage divided on entry.'),
  'Dragonlord Dromoka': c(6, '{4}{G}{W}', 'Legendary Creature — Elder Dragon', [], 'Opponents cannot cast on your turn.'),
  'Dragonlord Kolaghan': c(6, '{4}{B}{R}', 'Legendary Creature — Elder Dragon', [], 'Haste; punishes recasts.'),
  'Dragonlord Ojutai': c(5, '{3}{W}{U}', 'Legendary Creature — Elder Dragon', ['draw'], 'Anticipate on combat damage.'),
  'Dragonlord Silumgar': c(6, '{4}{U}{B}', 'Legendary Creature — Elder Dragon', [], 'Steal a creature or planeswalker.'),
  'Silumgar, the Drifting Death': c(6, '{4}{U}{B}', 'Legendary Creature — Dragon', [], '-1/-1 to defenders per attacking Dragon.'),
  'Atarka, World Render': c(7, '{5}{R}{G}', 'Legendary Creature — Dragon', [], 'Attacking Dragons get double strike.'),
  'Dromoka, the Eternal': c(6, '{4}{G}{W}', 'Legendary Creature — Dragon', [], 'Bolster 2 on Dragon attacks.'),
  'Glorybringer': c(5, '{3}{R}{R}', 'Creature — Dragon', ['removal'], 'Exert: 4 damage to a creature.'),
  'Thunderbreak Regent': c(4, '{2}{R}{R}', 'Creature — Dragon', [], 'Taxes targeted removal 3 life.'),
  'Verix Bladewing': c(4, '{2}{R}{R}', 'Legendary Creature — Dragon', [], 'Kicker: bring a twin.'),
  'Demanding Dragon': c(5, '{3}{R}{R}', 'Creature — Dragon', [], 'Sacrifice or take 5 on entry.'),
  'Balefire Dragon': c(7, '{5}{R}{R}', 'Creature — Dragon', ['wipe'], 'Combat damage wipes their board.'),
  'Steel Hellkite': c(6, '{6}', 'Artifact Creature — Dragon', ['removal'], 'Sweep nonland permanents on hit.'),
  'Savage Ventmaw': c(6, '{4}{R}{G}', 'Creature — Dragon', ['ramp'], 'Six mana on attack.'),
  'Drakuseth, Maw of Flames': c(7, '{4}{R}{R}{R}', 'Creature — Dragon', ['removal'], '7 damage divided on attack.'),
  'Beledros Witherbloom': c(7, '{5}{B}{G}', 'Legendary Creature — Elder Dragon', ['ramp'], 'Untap all lands for 10 life.'),
  'Miirym, Sentinel Wyrm': c(6, '{3}{G}{U}{R}', 'Legendary Creature — Dragon Spirit', [], 'Copies your entering Dragons.'),
  'Tiamat': c(7, '{2}{W}{U}{B}{R}{G}', 'Legendary Creature — Dragon God', ['draw'], 'Tutor five Dragons on cast.'),
  'Morophon, the Boundless': c(7, '{7}', 'Legendary Creature — Shapeshifter', [], 'Dragons cost {W}{U}{B}{R}{G} less.'),
  'Heroic Intervention': c(2, '{1}{G}', 'Instant', ['protection'], 'Hexproof + indestructible for your board.'),
  'Lightning Greaves': c(2, '{2}', 'Artifact — Equipment', ['protection'], 'Shroud and haste, free equips.'),
  'Swiftfoot Boots': c(2, '{2}', 'Artifact — Equipment', ['protection'], 'Hexproof and haste.'),
  'Command Tower': c(0, '', 'Land', ['land'], 'Any color in your commander identity.'),
  'Exotic Orchard': c(0, '', 'Land', ['land'], 'Colors your opponents can produce.'),
  'Path of Ancestry': c(0, '', 'Land', ['land'], 'Tapped; scry on tribal casts.'),
  'Haven of the Spirit Dragon': c(0, '', 'Land', ['land'], 'Recur Dragons from the graveyard.'),
  'Cavern of Souls': c(0, '', 'Land', ['land'], 'Uncounterable tribal casts.'),
  'City of Brass': c(0, '', 'Land', ['land'], 'Any color for 1 damage.'),
  'Mana Confluence': c(0, '', 'Land', ['land'], 'Any color for 1 life.'),
  'Reflecting Pool': c(0, '', 'Land', ['land'], 'Colors your other lands produce.'),
  'Arid Mesa': c(0, '', 'Land', ['land'], 'Fetch a Mountain or Plains.'),
  'Bloodstained Mire': c(0, '', 'Land', ['land'], 'Fetch a Swamp or Mountain.'),
  'Windswept Heath': c(0, '', 'Land', ['land'], 'Fetch a Forest or Plains.'),
  'Wooded Foothills': c(0, '', 'Land', ['land'], 'Fetch a Mountain or Forest.'),
  'Polluted Delta': c(0, '', 'Land', ['land'], 'Fetch an Island or Swamp.'),
  'Badlands': c(0, '', 'Land — Swamp Mountain', ['land'], ''),
  'Bayou': c(0, '', 'Land — Swamp Forest', ['land'], ''),
  'Ketria Triome': c(0, '', 'Land — Forest Island Mountain', ['land'], 'Three colors; cycling.'),
  'Savai Triome': c(0, '', 'Land — Mountain Plains Swamp', ['land'], 'Three colors; cycling.'),
  'Mountain': c(0, '', 'Basic Land — Mountain', ['land'], ''),
  'Forest': c(0, '', 'Basic Land — Forest', ['land'], ''),
  'Plains': c(0, '', 'Basic Land — Plains', ['land'], ''),
  'Island': c(0, '', 'Basic Land — Island', ['land'], ''),
  'Swamp': c(0, '', 'Basic Land — Swamp', ['land'], ''),
  'Mind Stone': c(2, '{2}', 'Artifact', ['ramp'], 'Mana rock; cash in for a card later.'),
  'Thought Vessel': c(2, '{2}', 'Artifact', ['ramp'], 'Mana rock; no maximum hand size.'),
  "Wayfarer's Bauble": c(1, '{1}', 'Artifact', ['ramp'], 'Fetch a basic onto the battlefield.'),
  'Smothering Tithe': c(4, '{3}{W}', 'Enchantment', ['ramp'], 'Treasure when opponents draw.'),
  'Windfall': c(3, '{2}{U}', 'Sorcery', ['draw'], 'Everyone wheels.'),
  'Greed': c(4, '{3}{B}', 'Enchantment', ['draw'], 'Pay life, draw cards, repeat.'),
  'Cyclonic Rift': c(2, '{1}{U}', 'Instant', ['removal'], 'Overload: bounce everything they own.'),
  'Anguished Unmaking': c(3, '{1}{W}{B}', 'Instant', ['removal'], 'Exile any nonland permanent.'),
  'Negate': c(2, '{1}{U}', 'Instant', ['counter'], 'Counter target noncreature spell.'),
  'Swan Song': c(1, '{U}', 'Instant', ['counter'], 'Counter for one mana; they get a bird.'),
  "Teferi's Protection": c(3, '{2}{W}', 'Instant', ['protection'], 'Phase out of an entire turn.'),
  'Approach of the Second Sun': c(7, '{6}{W}', 'Sorcery', ['wincon'], 'Cast it twice, win the game.'),
}

const DB_INDEX: Record<string, string> = {}
for (const name of Object.keys(MOX_DB)) {
  DB_INDEX[name.toLowerCase()] = name
}

export function lookupCard(name: string): string | undefined {
  return DB_INDEX[name.toLowerCase()]
}

export function getAllCardNames(): string[] {
  return Object.keys(MOX_DB)
}

export const DEFAULT_DECKLIST = `// Commander
1 The Ur-Dragon

// Ramp
1 Sol Ring
1 Arcane Signet
1 Fellwar Stone
1 Chromatic Lantern
1 Dragon's Hoard
1 Cultivate
1 Kodama's Reach
1 Farseek
1 Rampant Growth
1 Three Visits
1 Nature's Lore
1 Skyshroud Claim
1 Explosive Vegetation

// Card draw
1 Rhystic Study
1 Phyrexian Arena
1 Elemental Bond
1 Kindred Discovery
1 Temur Ascendancy
1 Garruk's Uprising
1 Return of the Wildspeaker
1 Painful Truths
1 Shamanic Revelation
1 Harmonize

// Interaction
1 Swords to Plowshares
1 Path to Exile
1 Beast Within
1 Chaos Warp
1 Counterspell
1 Wrath of God
1 Blasphemous Act
1 Crux of Fate
1 Sarkhan's Unsealing

// Dragons & support
1 Hellkite Tyrant
1 Lathliss, Dragon Queen
1 Terror of the Peaks
1 Goldspan Dragon
1 Old Gnawbone
1 Utvara Hellkite
1 Scourge of Valkas
1 Dragon Tempest
1 Crucible of Fire
1 Dragonlord Atarka
1 Dragonlord Dromoka
1 Dragonlord Kolaghan
1 Dragonlord Ojutai
1 Dragonlord Silumgar
1 Silumgar, the Drifting Death
1 Atarka, World Render
1 Dromoka, the Eternal
1 Glorybringer
1 Thunderbreak Regent
1 Verix Bladewing
1 Demanding Dragon
1 Balefire Dragon
1 Steel Hellkite
1 Savage Ventmaw
1 Drakuseth, Maw of Flames
1 Beledros Witherbloom
1 Miirym, Sentinel Wyrm
1 Tiamat
1 Morophon, the Boundless
1 Heroic Intervention
1 Lightning Greaves
1 Swiftfoot Boots

// Lands
1 Command Tower
1 Exotic Orchard
1 Path of Ancestry
1 Haven of the Spirit Dragon
1 Cavern of Souls
1 City of Brass
1 Mana Confluence
1 Reflecting Pool
1 Arid Mesa
1 Bloodstained Mire
1 Windswept Heath
1 Wooded Foothills
1 Polluted Delta
1 Badlands
1 Bayou
1 Ketria Triome
1 Savai Triome
4 Mountain
4 Forest
4 Plains
3 Island
3 Swamp`
