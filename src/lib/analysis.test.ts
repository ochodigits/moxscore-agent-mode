import { describe, it, expect } from 'vitest'
import type { Card, SubScores } from '../types/card.ts'
import {
  isRamp,
  isDraw,
  isRemoval,
  isCounterspell,
  isBoardWipe,
  isLand,
  isProtection,
  isWincon,
  buildManaCurve,
  scoreDecklist,
} from './analysis.ts'
// Score formulas live in the shared scoring module — the same code the live
// Scryfall engine and the offline fallback both run in production.
import {
  formatParams,
  scoreRamp,
  scoreInteraction,
  scoreDraw,
  scoreLands,
  scoreWincons,
  scoreCurve,
  composeScore,
} from './scoring.ts'
import { DEFAULT_FORMAT } from './formats.ts'

const P = formatParams(DEFAULT_FORMAT) // Commander: ideals 10/10/10, lands 32/37/40, cmc 3.0

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<Card> & { qty: number; cmc: number }): Card {
  return {
    id: 'test-id',
    name: overrides.name ?? 'Test Card',
    qty: overrides.qty,
    cmc: overrides.cmc,
    mana_cost: overrides.mana_cost ?? '',
    type_line: overrides.isLand === true ? 'Basic Land' : (overrides.type_line ?? 'Creature'),
    colors: overrides.colors ?? [],
    color_identity: overrides.color_identity ?? [],
    oracle_text: overrides.oracle_text ?? '',
    power: overrides.power ?? null,
    keywords: overrides.keywords ?? [],
    usd: null,
    eur: null,
    set_name: 'Test Set',
    image_uri: null,
    isRamp: overrides.isRamp ?? false,
    isDraw: overrides.isDraw ?? false,
    isRemoval: overrides.isRemoval ?? false,
    isCounterspell: overrides.isCounterspell ?? false,
    isBoardWipe: overrides.isBoardWipe ?? false,
    isLand: overrides.isLand ?? false,
    isProtection: overrides.isProtection ?? false,
    isWincon: overrides.isWincon ?? false,
    isCreature: overrides.isCreature ?? false,
    isEvasive: overrides.isEvasive ?? false,
    isAuraOrEquipment: overrides.isAuraOrEquipment ?? false,
  }
}

// ---------------------------------------------------------------------------
// Category detectors
// ---------------------------------------------------------------------------

describe('isRamp', () => {
  it('returns true when oracle contains "add {"', () => {
    expect(isRamp('{T}: Add {G} to your mana pool.', '')).toBe(true)
  })
  it('returns true when oracle contains "add one mana"', () => {
    expect(isRamp('You may add one mana of any color.', '')).toBe(true)
  })
  it('returns true when type line contains "mana" (mana rocks)', () => {
    expect(isRamp('{T}: Add {C}{C}{C}.', 'Artifact — Mana')).toBe(true)
  })
  it('returns true for land search ramp spells', () => {
    expect(isRamp('Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', 'Sorcery')).toBe(true)
  })
  it('returns true for Treasure makers', () => {
    expect(isRamp('Create a Treasure token.', 'Instant')).toBe(true)
  })
  it('returns false for non-ramp oracle text', () => {
    expect(isRamp('Draw a card.', 'Creature')).toBe(false)
  })
})

// Verbatim oracle-text fixtures for the ramp detector — real cards the beta
// tester's deck exposed as false negatives / false positives.
describe('isRamp — verbatim oracle fixtures', () => {
  it("recognizes Nature's Lore (Forest search, no 'land' in the search clause)", () => {
    expect(isRamp('Search your library for a Forest card, put that card onto the battlefield, then shuffle.', 'Sorcery')).toBe(true)
  })
  it('recognizes Three Visits', () => {
    expect(isRamp('Search your library for a Forest card, put that card onto the battlefield, then shuffle.', 'Sorcery')).toBe(true)
  })
  it('recognizes Farseek (typed nonbasic search)', () => {
    expect(isRamp('Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.', 'Sorcery')).toBe(true)
  })
  it('recognizes Cultivate', () => {
    expect(isRamp('Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', 'Sorcery')).toBe(true)
  })
  it("recognizes Kodama's Reach", () => {
    expect(isRamp('Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', 'Sorcery — Arcane')).toBe(true)
  })
  it('recognizes Skyshroud Claim', () => {
    expect(isRamp('Search your library for up to two Forest cards, put them onto the battlefield, then shuffle.', 'Sorcery')).toBe(true)
  })
  it('recognizes Utopia Sprawl (mana-producing enchantment)', () => {
    expect(isRamp('Enchant Forest\nAs this Aura enters, choose a color.\nWhenever enchanted Forest is tapped for mana, its controller adds an additional one mana of the chosen color.', 'Enchantment — Aura')).toBe(true)
  })
  it('recognizes Wild Growth', () => {
    expect(isRamp('Enchant land\nWhenever enchanted land is tapped for mana, its controller adds an additional {G}.', 'Enchantment — Aura')).toBe(true)
  })
  it('does NOT count Savage Ventmaw (mana only on attack trigger is not ramp)', () => {
    expect(isRamp('Flying\nWhenever this creature attacks, add {R}{R}{R}{G}{G}{G}. Until end of turn, you don\'t lose this mana as steps and phases end.', 'Creature — Dragon')).toBe(false)
  })
  it('does NOT count Neheb-style combat-damage mana', () => {
    expect(isRamp('Whenever a creature deals combat damage to a player, add {R} for each 1 damage dealt.', 'Legendary Creature — Minotaur Warrior')).toBe(false)
  })
  it('still counts Smothering Tithe (non-combat trigger, real ramp)', () => {
    expect(isRamp('Whenever an opponent draws a card, that player may pay {2}. If the player doesn\'t, you create a Treasure token.', 'Enchantment')).toBe(true)
  })
})

describe('isDraw', () => {
  it('returns true for "draw a card"', () => {
    expect(isDraw('Draw a card.')).toBe(true)
  })
  it('returns true for "draw two cards"', () => {
    expect(isDraw('Draw two cards.')).toBe(true)
  })
  it('returns true for "draw X cards"', () => {
    expect(isDraw('Draw X cards.')).toBe(true)
  })
  it('returns true for "draw 3 cards" via regex', () => {
    expect(isDraw('Draw 3 cards.')).toBe(true)
  })
  it('returns true for library-to-hand advantage', () => {
    expect(isDraw('Put one of them from your library into your hand.')).toBe(true)
  })
  it('returns false for non-draw oracle text', () => {
    expect(isDraw('Add {G} to your mana pool.')).toBe(false)
  })
})

describe('isRemoval', () => {
  it('returns true for "destroy target creature"', () => {
    expect(isRemoval('Destroy target creature.')).toBe(true)
  })
  it('returns true for "exile target nonland permanent"', () => {
    expect(isRemoval('Exile target nonland permanent.')).toBe(true)
  })
  it('returns true for bounce and damage removal', () => {
    expect(isRemoval('Return target nonland permanent to its owner hand.')).toBe(true)
    expect(isRemoval('This deals 3 damage to any target.')).toBe(true)
  })
  it('returns false when oracle contains "destroy all" (board wipe)', () => {
    expect(isRemoval('Destroy all creatures.')).toBe(false)
  })
  it('returns false when oracle contains "exile all"', () => {
    expect(isRemoval('Exile all creatures.')).toBe(false)
  })
  it('returns false for non-removal oracle text', () => {
    expect(isRemoval('Draw a card.')).toBe(false)
  })
})

describe('isCounterspell', () => {
  it('returns true for an instant that counters a spell', () => {
    expect(isCounterspell('Counter target spell.', 'Instant')).toBe(true)
  })
  it('returns false when type is not Instant', () => {
    expect(isCounterspell('Counter target spell.', 'Sorcery')).toBe(false)
  })
  it('returns false for non-counter instant', () => {
    expect(isCounterspell('Draw a card.', 'Instant')).toBe(false)
  })
})

describe('isBoardWipe', () => {
  it('returns true for "destroy all creatures"', () => {
    expect(isBoardWipe('Destroy all creatures.')).toBe(true)
  })
  it('returns true for "exile all creatures"', () => {
    expect(isBoardWipe('Exile all creatures.')).toBe(true)
  })
  it('returns true for damage to each creature', () => {
    expect(isBoardWipe('This deals 5 damage to each creature.')).toBe(true)
  })
  it('returns true for each creature shrink effects', () => {
    expect(isBoardWipe('Each creature gets -3/-3 until end of turn.')).toBe(true)
  })
  it('returns false for single-target removal', () => {
    expect(isBoardWipe('Destroy target creature.')).toBe(false)
  })
})

describe('isLand', () => {
  it('returns true for "Basic Land — Forest"', () => {
    expect(isLand('Basic Land — Forest')).toBe(true)
  })
  it('returns true for "Land" alone', () => {
    expect(isLand('Land')).toBe(true)
  })
  it('returns false for non-land type', () => {
    expect(isLand('Artifact')).toBe(false)
  })
  it('returns false for creature type', () => {
    expect(isLand('Creature — Human')).toBe(false)
  })
})

describe('isProtection', () => {
  it('recognizes Swiftfoot Boots (grants hexproof)', () => {
    expect(isProtection('Equipped creature has hexproof and haste.\nEquip {1}')).toBe(true)
  })
  it('recognizes Heroic Intervention', () => {
    expect(isProtection('Permanents you control gain hexproof and indestructible until end of turn.')).toBe(true)
  })
  it("recognizes Teferi's Protection", () => {
    expect(isProtection('Until your next turn, your life total can\'t change and you have protection from everything. All permanents you control phase out.')).toBe(true)
  })
  it('recognizes Veil of Summer (counterspell-proofing)', () => {
    expect(isProtection('Draw a card if an opponent has cast a blue or black spell this turn. Spells you control can\'t be countered this turn. You and permanents you control gain hexproof from blue and from black until end of turn.')).toBe(true)
  })
  it('recognizes fog effects', () => {
    expect(isProtection('Prevent all combat damage that would be dealt this turn.')).toBe(true)
  })
  it('does NOT flag Wrath of God ("can\'t be regenerated" is not protection)', () => {
    expect(isProtection("Destroy all creatures. They can't be regenerated.")).toBe(false)
  })
  it('does NOT flag a self-hexproof beater (keyword without granting)', () => {
    expect(isProtection("This spell can't be countered.\nHexproof\nTrample")).toBe(false)
  })
  it('returns false for non-protection oracle text', () => {
    expect(isProtection('Draw a card.')).toBe(false)
  })
})

describe('isWincon', () => {
  it("returns true for known wincon name (Thassa's Oracle)", () => {
    expect(isWincon("Thassa's Oracle", '')).toBe(true)
  })
  it('returns true when oracle contains "you win the game"', () => {
    expect(isWincon('Unknown Card', 'You win the game.')).toBe(true)
  })
  it('returns false for neither known name nor oracle phrase', () => {
    expect(isWincon('Sol Ring', 'Add {C}{C}.')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Score formulas
// ---------------------------------------------------------------------------

describe('scoreRamp', () => {
  it('returns 0 for 0 ramp spells', () => {
    expect(scoreRamp(0, P.idealRamp)).toBe(0)
  })
  it('returns 50 for 5 ramp spells', () => {
    expect(scoreRamp(5, P.idealRamp)).toBe(50)
  })
  it('returns 100 for 10 ramp spells', () => {
    expect(scoreRamp(10, P.idealRamp)).toBe(100)
  })
  it('caps at 100 for more than 10', () => {
    expect(scoreRamp(15, P.idealRamp)).toBe(100)
  })
})

describe('scoreInteraction', () => {
  it('returns 0 for 0 interaction spells', () => {
    expect(scoreInteraction(0, P.idealInteraction)).toBe(0)
  })
  it('returns 100 for 10 or more interaction spells', () => {
    expect(scoreInteraction(10, P.idealInteraction)).toBe(100)
  })
})

describe('scoreDraw', () => {
  it('returns 0 for 0 draw spells', () => {
    expect(scoreDraw(0, P.idealDraw)).toBe(0)
  })
  it('returns 100 for 10 or more draw spells', () => {
    expect(scoreDraw(10, P.idealDraw)).toBe(100)
  })
})

describe('scoreLands', () => {
  it('returns 0 for fewer than 32 lands', () => {
    expect(scoreLands(30, P)).toBe(0)
    expect(scoreLands(31, P)).toBe(0)
  })
  it('returns 100 for 36–38 lands (peak ±1)', () => {
    expect(scoreLands(36, P)).toBe(100)
    expect(scoreLands(37, P)).toBe(100)
    expect(scoreLands(38, P)).toBe(100)
  })
  it('returns 60 for more than 40 lands', () => {
    expect(scoreLands(41, P)).toBe(60)
    expect(scoreLands(45, P)).toBe(60)
  })
  it('returns between 30 and 100 for 32–35 lands', () => {
    expect(scoreLands(32, P)).toBeGreaterThanOrEqual(30)
    expect(scoreLands(35, P)).toBeLessThan(100)
  })
  it('never exceeds 100 for 39–40 lands (regression: old interpolation gave 152–170)', () => {
    expect(scoreLands(39, P)).toBeLessThanOrEqual(100)
    expect(scoreLands(40, P)).toBeLessThanOrEqual(100)
    // taper: strong-but-not-perfect scores, monotonically decreasing
    expect(scoreLands(39, P)).toBeLessThan(scoreLands(38, P))
    expect(scoreLands(40, P)).toBeLessThan(scoreLands(39, P))
    expect(scoreLands(40, P)).toBeGreaterThan(scoreLands(41, P))
  })
  it('every count from 0 to 60 stays within [0, 100]', () => {
    for (let n = 0; n <= 60; n += 1) {
      expect(scoreLands(n, P)).toBeGreaterThanOrEqual(0)
      expect(scoreLands(n, P)).toBeLessThanOrEqual(100)
    }
  })
})

describe('scoreWincons', () => {
  it('returns 0 for 0 win conditions', () => {
    expect(scoreWincons(0)).toBe(0)
  })
  it('returns 50 for exactly 1 win condition', () => {
    expect(scoreWincons(1)).toBe(50)
  })
  it('returns 100 for 2 or more win conditions', () => {
    expect(scoreWincons(2)).toBe(100)
    expect(scoreWincons(5)).toBe(100)
  })
})

describe('scoreCurve', () => {
  it('returns 100 for avgCmc of exactly 3.0', () => {
    expect(scoreCurve(3.0, P.idealCmc)).toBe(100)
  })
  it('returns 75 for avgCmc of 4.0', () => {
    expect(scoreCurve(4.0, P.idealCmc)).toBe(75)
  })
  it('returns 0 for avgCmc very far from 3.0', () => {
    expect(scoreCurve(7.0, P.idealCmc)).toBe(0)
  })
})

const ZERO_SUBS: SubScores = { ramp: 0, interaction: 0, draw: 0, wipes: 0, protection: 0, curve: 0, lands: 0, wincons: 0 }

describe('composeScore', () => {
  it('returns 100 when all sub-scores are 100', () => {
    const all100: SubScores = { ramp: 100, interaction: 100, draw: 100, wipes: 100, protection: 100, curve: 100, lands: 100, wincons: 100 }
    expect(composeScore(all100)).toBe(100)
  })
  it('returns 0 when all sub-scores are 0', () => {
    expect(composeScore(ZERO_SUBS)).toBe(0)
  })
  it('weights ramp at 18%', () => {
    expect(composeScore({ ...ZERO_SUBS, ramp: 100 })).toBeCloseTo(18)
  })
  it('weights lands at 14%', () => {
    expect(composeScore({ ...ZERO_SUBS, lands: 100 })).toBeCloseTo(14)
  })
  it('clamps sub-scores above 100 before weighting (no path may exceed 100 overall)', () => {
    const inflated: SubScores = { ramp: 170, interaction: 150, draw: 200, wipes: 150, protection: 150, curve: 150, lands: 170, wincons: 150 }
    expect(composeScore(inflated)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// buildManaCurve
// ---------------------------------------------------------------------------

describe('buildManaCurve', () => {
  it('correctly buckets cards by cmc', () => {
    const cards: Card[] = [
      makeCard({ cmc: 1, qty: 2 }),
      makeCard({ cmc: 3, qty: 1 }),
      makeCard({ cmc: 7, qty: 1 }),
    ]
    const curve = buildManaCurve(cards)
    expect(curve[1]).toBe(2)
    expect(curve[3]).toBe(1)
    expect(curve['7+']).toBe(1)
  })

  it('excludes lands from the curve', () => {
    const cards: Card[] = [
      makeCard({ cmc: 0, qty: 37, isLand: true }),
      makeCard({ cmc: 2, qty: 4 }),
    ]
    const curve = buildManaCurve(cards)
    expect(curve[0]).toBe(0)
    expect(curve[2]).toBe(4)
  })

  it('multiplies card.qty correctly', () => {
    const cards: Card[] = [makeCard({ cmc: 4, qty: 5 })]
    const curve = buildManaCurve(cards)
    expect(curve[4]).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// scoreDecklist integration
// ---------------------------------------------------------------------------

describe('scoreDecklist', () => {
  it('returns healthScore between 0 and 100', () => {
    const cards: Card[] = [
      makeCard({ cmc: 0, qty: 37, isLand: true }),
      makeCard({ cmc: 2, qty: 10, isRamp: true }),
      makeCard({ cmc: 3, qty: 10, isDraw: true }),
      makeCard({ cmc: 3, qty: 5, isRemoval: true }),
      makeCard({ cmc: 4, qty: 1, isWincon: true }),
    ]
    const result = scoreDecklist(cards)
    expect(result.healthScore).toBeGreaterThanOrEqual(0)
    expect(result.healthScore).toBeLessThanOrEqual(100)
  })

  it('correctly reports landCount and rampCount', () => {
    const cards: Card[] = [
      makeCard({ cmc: 0, qty: 36, isLand: true }),
      makeCard({ cmc: 2, qty: 8, isRamp: true }),
    ]
    const result = scoreDecklist(cards)
    expect(result.landCount).toBe(36)
    expect(result.rampCount).toBe(8)
  })

  it('counts removal and counterspells as interaction, board wipes separately', () => {
    const cards: Card[] = [
      makeCard({ cmc: 2, qty: 3, isRemoval: true }),
      makeCard({ cmc: 2, qty: 2, isCounterspell: true }),
      makeCard({ cmc: 5, qty: 1, isBoardWipe: true }),
    ]
    const result = scoreDecklist(cards)
    expect(result.interactionCount).toBe(5)
    expect(result.boardWipeCount).toBe(1)
  })

  it('excludes lands from the draw count (War Room, cycling lands)', () => {
    const cards: Card[] = [
      makeCard({ cmc: 0, qty: 1, isLand: true, isDraw: true, name: 'War Room' }),
      makeCard({ cmc: 3, qty: 2, isDraw: true }),
    ]
    expect(scoreDecklist(cards).drawCount).toBe(2)
  })

  it('counts wincons by distinct card, not by copies', () => {
    const cards: Card[] = [makeCard({ cmc: 4, qty: 2, isWincon: true, name: 'Approach of the Second Sun' })]
    expect(scoreDecklist(cards).winconCount).toBe(1)
  })

  it('recognizes a combat win path as a win condition (aggro/voltron decks)', () => {
    const cards: Card[] = [
      makeCard({ cmc: 3, qty: 13, isCreature: true, name: 'Bears' }),
      makeCard({ cmc: 2, qty: 6, isCreature: true, isEvasive: true, name: 'Fliers' }),
    ]
    const result = scoreDecklist(cards)
    expect(result.winconCount).toBe(1)
  })

  it('does not invent a combat win path for a creature-light deck', () => {
    const cards: Card[] = [makeCard({ cmc: 3, qty: 5, isCreature: true, isEvasive: true })]
    expect(scoreDecklist(cards).winconCount).toBe(0)
  })
})
