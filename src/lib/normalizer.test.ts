import { describe, it, expect } from 'vitest'
import { normalizeDeck } from './normalizer.ts'
import type { ScryfallCard } from './scryfall.ts'

// Realistic Scryfall shapes: MDFC/transform cards have NO root-level
// oracle_text, mana_cost, or image_uris — everything lives in card_faces.
const VALAKUT_AWAKENING: ScryfallCard = {
  id: 'valakut-id',
  name: 'Valakut Awakening // Valakut Stoneforge',
  cmc: 3,
  type_line: 'Instant // Land',
  layout: 'modal_dfc',
  color_identity: ['R'],
  keywords: [],
  card_faces: [
    {
      name: 'Valakut Awakening',
      mana_cost: '{2}{R}',
      type_line: 'Instant',
      oracle_text:
        'Put any number of cards from your hand on the bottom of your library, then draw that many cards plus one.',
      colors: ['R'],
    },
    {
      name: 'Valakut Stoneforge',
      mana_cost: '',
      type_line: 'Land',
      oracle_text: 'Valakut Stoneforge enters the battlefield tapped.\n{T}: Add {R}.',
    },
  ],
  prices: { usd: null, eur: null },
  set_name: 'Zendikar Rising',
}

const AGADEEM: ScryfallCard = {
  id: 'agadeem-id',
  name: "Agadeem's Awakening // Agadeem, the Undercrypt",
  cmc: 3,
  type_line: 'Sorcery // Land',
  layout: 'modal_dfc',
  color_identity: ['B'],
  keywords: [],
  card_faces: [
    {
      name: "Agadeem's Awakening",
      mana_cost: '{X}{B}{B}{B}',
      type_line: 'Sorcery',
      oracle_text:
        'Return from your graveyard to the battlefield any number of creature cards that each have a different mana value X or less.',
      colors: ['B'],
    },
    {
      name: 'Agadeem, the Undercrypt',
      mana_cost: '',
      type_line: 'Land',
      oracle_text: 'As Agadeem, the Undercrypt enters the battlefield, you may pay 3 life.\n{T}: Add {B}.',
    },
  ],
  prices: { usd: null, eur: null },
  set_name: 'Zendikar Rising',
}

const SOL_RING: ScryfallCard = {
  id: 'sol-ring-id',
  name: 'Sol Ring',
  cmc: 1,
  mana_cost: '{1}',
  type_line: 'Artifact',
  oracle_text: '{T}: Add {C}{C}.',
  colors: [],
  color_identity: [],
  keywords: [],
  prices: { usd: null, eur: null },
  set_name: 'Commander 2021',
}

describe('normalizeDeck — double-faced and modal cards', () => {
  it('resolves front-face-only names from Moxfield exports to the full double-named card', () => {
    const { cards, unresolved } = normalizeDeck(
      [{ name: 'Valakut Awakening', qty: 1 }],
      [VALAKUT_AWAKENING],
    )
    expect(unresolved).toEqual([])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.name).toBe('Valakut Awakening // Valakut Stoneforge')
  })

  it('classifies an MDFC spell//land by its FRONT face — not as a land', () => {
    const { cards } = normalizeDeck([{ name: 'Valakut Awakening', qty: 1 }], [VALAKUT_AWAKENING])
    expect(cards[0]!.isLand).toBe(false)
    expect(cards[0]!.type_line).toBe('Instant')
    expect(cards[0]!.mana_cost).toBe('{2}{R}')
    expect(cards[0]!.cmc).toBe(3) // stays in the curve at the front face's cost
  })

  it("does not classify Agadeem's Awakening as a land (type_line 'Sorcery // Land')", () => {
    const { cards } = normalizeDeck([{ name: "Agadeem's Awakening", qty: 1 }], [AGADEEM])
    expect(cards[0]!.isLand).toBe(false)
  })

  it('detects categories from the concatenated oracle text of ALL faces', () => {
    const { cards } = normalizeDeck([{ name: 'Valakut Awakening', qty: 1 }], [VALAKUT_AWAKENING])
    // Front face is a draw spell ("draw that many cards plus one") — the card
    // must not have zero categories just because root oracle_text is absent.
    expect(cards[0]!.oracle_text).toContain('draw that many cards')
    expect(cards[0]!.oracle_text).toContain('{T}: Add {R}')
  })

  it('reports entries with no Scryfall match as unresolved instead of dropping them', () => {
    const { cards, unresolved } = normalizeDeck(
      [
        { name: 'Sol Ring', qty: 1 },
        { name: 'Completely Made Up Card', qty: 2 },
      ],
      [SOL_RING],
    )
    expect(cards).toHaveLength(1)
    expect(unresolved).toEqual([{ name: 'Completely Made Up Card', qty: 2 }])
  })

  it('still resolves ordinary single-faced cards by exact name', () => {
    const { cards, unresolved } = normalizeDeck([{ name: 'sol ring', qty: 1 }], [SOL_RING])
    expect(unresolved).toEqual([])
    expect(cards[0]!.isRamp).toBe(true)
  })
})
