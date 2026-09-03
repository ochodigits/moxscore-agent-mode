import { afterEach, describe, expect, it, vi } from 'vitest'

const parseDecklistMock = vi.hoisted(() => vi.fn())
const detectCommandersMock = vi.hoisted(() => vi.fn())
const fetchCardsMock = vi.hoisted(() => vi.fn())
const analyzeBracketMock = vi.hoisted(() => vi.fn())

vi.mock('./parser.ts', () => ({ parseDecklist: parseDecklistMock, detectCommanders: detectCommandersMock }))
vi.mock('./scryfall.ts', () => ({ fetchCards: fetchCardsMock }))
vi.mock('./bracketEngine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bracketEngine.ts')>()
  return { ...actual, analyzeBracket: analyzeBracketMock }
})

import { detectTunerDirection, runBracketTuner, targetAllowsUpgradePackage } from './bracketTuner'
import { bracketRule } from './bracketEngine'
import gamechangers from '../data/gamechangers.json'
import type { ScryfallCard } from './scryfall.ts'

const GC_NAMES = new Set(gamechangers.cards.map((card) => card.name.toLowerCase()))

function fakeCard(partial: Partial<ScryfallCard> & { name: string }): ScryfallCard {
  return {
    id: partial.name.toLowerCase().replace(/\s+/g, '-'),
    cmc: 2,
    type_line: 'Enchantment',
    oracle_text: 'Draw a card.',
    color_identity: [],
    prices: { eur: '1.00', usd: null },
    set_name: 'Test',
    legalities: { commander: 'legal' },
    ...partial,
  }
}

function mockFinalBracket(bracket: number, powerScore: number) {
  // Soft-loop simulate + final recalculation can call analyzeBracket several times.
  analyzeBracketMock.mockResolvedValue({ bracket, powerScore, flaggedCards: [], combos: [] })
}

describe('detectTunerDirection', () => {
  it('detects upgrade when below target bracket', () => {
    expect(detectTunerDirection({ bracket: 2, powerScore: 3 }, 4)).toBe('upgrade')
  })
  it('detects downgrade when above target bracket', () => {
    expect(detectTunerDirection({ bracket: 4, powerScore: 8 }, 2)).toBe('downgrade')
  })
  it('detects stable when inside target band', () => {
    const band = bracketRule(3).powerBand
    expect(detectTunerDirection({ bracket: 3, powerScore: (band[0]! + band[1]!) / 2 }, 3)).toBe('stable')
  })
})

describe('targetAllowsUpgradePackage', () => {
  it('never allows Game Changers when the target cap is 0', () => {
    expect(targetAllowsUpgradePackage(2, 'gameChanger', 0)).toBe(false)
  })
  it('allows Game Changers up to the target cap, and unlimited when max is null', () => {
    expect(targetAllowsUpgradePackage(3, 'gameChanger', 2)).toBe(true)
    expect(targetAllowsUpgradePackage(3, 'gameChanger', 3)).toBe(false)
    expect(targetAllowsUpgradePackage(4, 'gameChanger', 10)).toBe(true)
  })
})

describe('Bracket Tuner', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it('cuts fast mana with no replacement when tuning down', async () => {
    parseDecklistMock.mockReturnValue([{ name: 'Sol Ring', qty: 1 }])
    detectCommandersMock.mockReturnValue([])
    fetchCardsMock.mockResolvedValue({
      cards: [{ name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}.', color_identity: [] }],
      aliases: {},
    })
    analyzeBracketMock
      .mockResolvedValueOnce({
        bracket: 4, powerScore: 9, flaggedCards: [{ card: 'Sol Ring', reason: 'fastMana', detail: 'Fast mana', bracketImpact: 1 }], combos: [],
      })
      .mockResolvedValueOnce({
        bracket: 4, powerScore: 9, flaggedCards: [{ card: 'Sol Ring', reason: 'fastMana', detail: 'Fast mana', bracketImpact: 1 }], combos: [],
      })
    mockFinalBracket(2, 3)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await runBracketTuner({ decklist: '1 Sol Ring', targetBracket: 2, budgetEurPerCard: 5 })

    expect(result.swaps).toEqual([expect.objectContaining({
      cut: 'Sol Ring',
      add: null,
      reasoning: expect.stringContaining('no replacement'),
    })])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cuts tutors and Game Changers with no replacement', async () => {
    parseDecklistMock.mockReturnValue([
      { name: 'Demonic Tutor', qty: 1 },
      { name: 'Dockside Extortionist', qty: 1 },
    ])
    detectCommandersMock.mockReturnValue([])
    fetchCardsMock.mockResolvedValue({
      cards: [
        { name: 'Demonic Tutor', type_line: 'Sorcery', oracle_text: 'Search your library for a card.', color_identity: ['B'] },
        { name: 'Dockside Extortionist', type_line: 'Creature', oracle_text: 'Create Treasure tokens.', color_identity: ['R'] },
      ],
      aliases: {},
    })
    analyzeBracketMock
      .mockResolvedValueOnce({
        bracket: 4,
        powerScore: 9,
        flaggedCards: [
          { card: 'Dockside Extortionist', reason: 'gameChanger', detail: 'Game Changer', bracketImpact: 3 },
          { card: 'Demonic Tutor', reason: 'tutor', detail: 'Tutor', bracketImpact: 1 },
        ],
        combos: [],
      })
      .mockResolvedValueOnce({
        bracket: 4,
        powerScore: 9,
        flaggedCards: [
          { card: 'Dockside Extortionist', reason: 'gameChanger', detail: 'Game Changer', bracketImpact: 3 },
          { card: 'Demonic Tutor', reason: 'tutor', detail: 'Tutor', bracketImpact: 1 },
        ],
        combos: [],
      })
    mockFinalBracket(2, 3)

    vi.stubGlobal('fetch', vi.fn())

    const result = await runBracketTuner({
      decklist: '1 Demonic Tutor\n1 Dockside Extortionist',
      targetBracket: 2,
      budgetEurPerCard: 5,
    })

    expect(result.swaps.every((swap) => swap.add === null)).toBe(true)
    expect(result.swaps.map((swap) => swap.cut).sort()).toEqual(['Demonic Tutor', 'Dockside Extortionist'])
  })

  it('still replaces non-cut-only flags but refuses unsafe adds like Sol Ring', async () => {
    parseDecklistMock.mockReturnValue([{ name: 'Armageddon', qty: 1 }])
    detectCommandersMock.mockReturnValue([])
    fetchCardsMock
      .mockResolvedValueOnce({
        cards: [{ name: 'Armageddon', type_line: 'Sorcery', oracle_text: 'Destroy all lands.', color_identity: ['W'] }],
        aliases: {},
      })
      .mockResolvedValueOnce({
        cards: [{
          name: 'Safe Signet',
          type_line: 'Artifact',
          oracle_text: '{T}: Add one mana.',
          color_identity: [],
          prices: { eur: '1.00', usd: null },
          set_name: 'Test',
          id: 'safe',
          cmc: 2,
          legalities: { commander: 'legal' },
        }],
        aliases: {},
      })
    analyzeBracketMock
      .mockResolvedValueOnce({
        bracket: 4,
        powerScore: 8,
        flaggedCards: [{ card: 'Armageddon', reason: 'massLandDenial', detail: 'Mass land denial', bracketImpact: 3 }],
        combos: [],
      })
      .mockResolvedValueOnce({
        bracket: 3,
        powerScore: 5,
        flaggedCards: [],
        combos: [],
      })
    mockFinalBracket(3, 5)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { name: 'Sol Ring', prices: { eur: '1.00' } },
        { name: 'Safe Signet', prices: { eur: '1.00' } },
      ] }),
    }))

    const result = await runBracketTuner({ decklist: '1 Armageddon', targetBracket: 3, budgetEurPerCard: 5, ownershipMode: 'any' })

    expect(result.swaps).toEqual([expect.objectContaining({
      cut: 'Armageddon',
      add: 'Safe Signet',
    })])
  })

  it('enforces owned-only and exclusion filters before returning a replacement', async () => {
    parseDecklistMock.mockReturnValue([{ name: 'Armageddon', qty: 1 }])
    detectCommandersMock.mockReturnValue([])
    fetchCardsMock
      .mockResolvedValueOnce({
        cards: [{ name: 'Armageddon', type_line: 'Sorcery', oracle_text: 'Destroy all lands.', color_identity: ['W'] }],
        aliases: {},
      })
      .mockResolvedValueOnce({
        cards: [{
          name: 'Owned Signet',
          type_line: 'Artifact',
          oracle_text: '{T}: Add one mana.',
          color_identity: [],
          prices: { eur: '1.00', usd: null },
          set_name: 'Test',
          id: 'owned',
          cmc: 2,
          legalities: { commander: 'legal' },
        }],
        aliases: {},
      })
    analyzeBracketMock
      .mockResolvedValueOnce({
        bracket: 4,
        powerScore: 8,
        flaggedCards: [{ card: 'Armageddon', reason: 'massLandDenial', detail: 'Mass land denial', bracketImpact: 3 }],
        combos: [],
      })
      .mockResolvedValueOnce({
        bracket: 3,
        powerScore: 5,
        flaggedCards: [],
        combos: [],
      })
    mockFinalBracket(3, 5)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { name: 'Excluded Signet', prices: { eur: '1.00' } },
        { name: 'Owned Signet', prices: { eur: '1.00' } },
      ] }),
    }))

    const result = await runBracketTuner({
      decklist: '1 Armageddon', targetBracket: 3, budgetEurPerCard: 5,
      collection: ['Owned Signet'], ownershipMode: 'owned-only', excludedCardNames: ['Excluded Signet'],
    })

    expect(result.swaps).toEqual([expect.objectContaining({ add: 'Owned Signet', owned: true })])
  })

  it('documents TunerSwap allowing add-only upgrades', () => {
    const swap: import('./bracketTuner').TunerSwap = {
      cut: null,
      cutReason: 'Deck under 100 — add high-impact card',
      add: 'Rhystic Study',
      addEur: 40,
      role: 'draw',
      owned: false,
      reasoning: 'Add Rhystic Study to raise card advantage toward bracket 4.',
    }
    expect(swap.cut).toBeNull()
    expect(swap.add).toBe('Rhystic Study')
  })

  it('returns no swaps when the deck is already stable in the target band', async () => {
    parseDecklistMock.mockReturnValue([{ name: 'Command Tower', qty: 1 }])
    detectCommandersMock.mockReturnValue([])
    fetchCardsMock.mockResolvedValue({
      cards: [fakeCard({ name: 'Command Tower', type_line: 'Land', oracle_text: '{T}: Add one mana of any color.', cmc: 0 })],
      aliases: {},
    })
    const band = bracketRule(3).powerBand
    analyzeBracketMock.mockResolvedValue({
      bracket: 3, powerScore: (band[0]! + band[1]!) / 2, flaggedCards: [], combos: [],
    })

    const result = await runBracketTuner({ decklist: '1 Command Tower', targetBracket: 3, budgetEurPerCard: 5 })

    expect(result.swaps).toEqual([])
    expect(result.achievable).toBe(true)
    expect(result.resultingBracket).toBe(3)
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringMatching(/already within the target bracket band/i)]))
  })

  it('upgrade mode suggests adds toward a higher target without illegal GCs for low targets', async () => {
    const arena = fakeCard({
      name: 'Phyrexian Arena',
      type_line: 'Enchantment',
      oracle_text: 'At the beginning of your upkeep, you draw a card and you lose 1 life.',
      color_identity: ['B'],
      cmc: 3,
      prices: { eur: '4.00', usd: null },
    })
    parseDecklistMock.mockReturnValue([
      { name: 'Swamp', qty: 1 },
      { name: 'Gray Merchant of Asphodel', qty: 1 },
    ])
    detectCommandersMock.mockReturnValue(['Gray Merchant of Asphodel'])
    fetchCardsMock.mockImplementation(async (requested: Array<{ name: string }>) => {
      const catalog: Record<string, ScryfallCard> = {
        swamp: fakeCard({ name: 'Swamp', type_line: 'Basic Land — Swamp', oracle_text: '{T}: Add {B}.', cmc: 0, color_identity: ['B'] }),
        'gray merchant of asphodel': fakeCard({
          name: 'Gray Merchant of Asphodel',
          type_line: 'Creature — Zombie',
          oracle_text: 'Devotion to black.',
          color_identity: ['B', 'U'],
          cmc: 5,
        }),
        'phyrexian arena': arena,
        'rhystic study': fakeCard({
          name: 'Rhystic Study',
          type_line: 'Enchantment',
          oracle_text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
          color_identity: ['U'],
          cmc: 3,
          prices: { eur: '15.00', usd: null },
        }),
      }
      const cards = requested.map((entry) => catalog[entry.name.toLowerCase()]).filter((card): card is ScryfallCard => card !== undefined)
      return { cards, aliases: {} }
    })
    analyzeBracketMock.mockImplementation(async (entries: Array<{ name: string }>) => {
      const names = new Set(entries.map((entry) => entry.name.toLowerCase()))
      if (names.has('rhystic study') || names.has('phyrexian arena')) {
        return { bracket: 4, powerScore: 7, flaggedCards: [], combos: [] }
      }
      return { bracket: 2, powerScore: 3, flaggedCards: [], combos: [] }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'Phyrexian Arena', prices: { eur: '4.00' } }] }),
    }))

    const upgraded = await runBracketTuner({
      decklist: '1 Swamp\n1 Gray Merchant of Asphodel',
      targetBracket: 4,
      budgetEurPerCard: 20,
      ownershipMode: 'any',
    })

    expect(upgraded.swaps.length).toBeGreaterThanOrEqual(1)
    expect(upgraded.swaps.some((swap) => swap.add !== null && GC_NAMES.has(swap.add.toLowerCase()))).toBe(true)
    expect(upgraded.swaps.find((swap) => swap.add === 'Rhystic Study')?.cut).toBeNull()
    expect(upgraded.resultingBracket).toBe(4)

    parseDecklistMock.mockReturnValue([{ name: 'Island', qty: 1 }])
    detectCommandersMock.mockReturnValue([])
    const howlingMine = fakeCard({
      name: 'Howling Mine',
      type_line: 'Artifact',
      oracle_text: 'At the beginning of each player\'s draw step, if Howling Mine is untapped, that player draws an additional card.',
      color_identity: [],
      cmc: 2,
      prices: { eur: '2.00', usd: null },
    })
    const rhysticStudy = fakeCard({
      name: 'Rhystic Study',
      type_line: 'Enchantment',
      oracle_text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
      color_identity: ['U'],
      cmc: 3,
      prices: { eur: '40.00', usd: null },
    })
    fetchCardsMock.mockImplementation(async (requested: Array<{ name: string }>) => {
      const catalog: Record<string, ScryfallCard> = {
        island: fakeCard({ name: 'Island', type_line: 'Basic Land — Island', oracle_text: '{T}: Add {U}.', cmc: 0, color_identity: ['U'] }),
        'howling mine': howlingMine,
        'rhystic study': rhysticStudy,
      }
      const cards = requested.map((entry) => catalog[entry.name.toLowerCase()]).filter((card): card is ScryfallCard => card !== undefined)
      return { cards, aliases: {} }
    })
    analyzeBracketMock.mockImplementation(async (entries: Array<{ name: string }>) => {
      const names = new Set(entries.map((entry) => entry.name.toLowerCase()))
      if (names.has('rhystic study')) {
        return { bracket: 4, powerScore: 8, flaggedCards: [], combos: [] }
      }
      if (names.has('howling mine')) {
        return { bracket: 2, powerScore: 3, flaggedCards: [], combos: [] }
      }
      return { bracket: 2, powerScore: 1, flaggedCards: [], combos: [] }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { name: 'Howling Mine', prices: { eur: '2.00' } },
        { name: 'Rhystic Study', prices: { eur: '40.00' } },
      ] }),
    }))

    const towardCore = await runBracketTuner({
      decklist: '1 Island',
      targetBracket: 2,
      budgetEurPerCard: 50,
      ownershipMode: 'any',
    })

    // Target bracket 2 has gameChangersMax: 0 — upgrade must never suggest GCs.
    expect(towardCore.swaps.length).toBeGreaterThanOrEqual(1)
    expect(towardCore.swaps.some((swap) => swap.add !== null && GC_NAMES.has(swap.add.toLowerCase()))).toBe(false)
    expect(towardCore.swaps.map((swap) => swap.add)).not.toContain('Rhystic Study')
  })

  it('upgrade mode cuts a high-CMC nonland when the deck is already 100 cards', async () => {
    const arena = fakeCard({
      name: 'Phyrexian Arena',
      type_line: 'Enchantment',
      oracle_text: 'At the beginning of your upkeep, you draw a card and you lose 1 life.',
      color_identity: ['B'],
      cmc: 3,
      prices: { eur: '4.00', usd: null },
    })
    parseDecklistMock.mockReturnValue([
      { name: 'Gray Merchant of Asphodel', qty: 1 },
      { name: 'Swamp', qty: 98 },
      { name: 'Colossal Dreadmaw', qty: 1 },
    ])
    detectCommandersMock.mockReturnValue(['Gray Merchant of Asphodel'])
    fetchCardsMock.mockImplementation(async (requested: Array<{ name: string }>) => {
      const catalog: Record<string, ScryfallCard> = {
        swamp: fakeCard({ name: 'Swamp', type_line: 'Basic Land — Swamp', oracle_text: '{T}: Add {B}.', cmc: 0, color_identity: ['B'] }),
        'gray merchant of asphodel': fakeCard({
          name: 'Gray Merchant of Asphodel',
          type_line: 'Creature — Zombie',
          oracle_text: 'Devotion to black.',
          color_identity: ['B'],
          cmc: 5,
        }),
        'colossal dreadmaw': fakeCard({
          name: 'Colossal Dreadmaw',
          type_line: 'Creature — Dinosaur',
          oracle_text: 'Trample',
          color_identity: ['G'],
          cmc: 6,
        }),
        'phyrexian arena': arena,
      }
      const cards = requested.map((entry) => catalog[entry.name.toLowerCase()]).filter((card): card is ScryfallCard => card !== undefined)
      return { cards, aliases: {} }
    })
    analyzeBracketMock.mockImplementation(async (entries: Array<{ name: string }>) => {
      const names = new Set(entries.map((entry) => entry.name.toLowerCase()))
      if (names.has('phyrexian arena')) {
        return { bracket: 4, powerScore: 7, flaggedCards: [], combos: [] }
      }
      return { bracket: 2, powerScore: 3, flaggedCards: [], combos: [] }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'Phyrexian Arena', prices: { eur: '4.00' } }] }),
    }))

    const result = await runBracketTuner({
      decklist: '99 Swamp\n1 Colossal Dreadmaw',
      targetBracket: 4,
      budgetEurPerCard: 20,
      ownershipMode: 'any',
    })

    expect(result.swaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ cut: 'Colossal Dreadmaw', add: 'Phyrexian Arena' }),
    ]))
  })

  it('never weak-cuts a card added earlier in the same upgrade run', async () => {
    const dreamstone = fakeCard({
      name: 'Dreamstone Hedron',
      type_line: 'Artifact',
      oracle_text: '{T}: Add {C}{C}{C}.',
      color_identity: [],
      cmc: 6,
      prices: { eur: '1.00', usd: null },
    })
    const archive = fakeCard({
      name: 'Hedron Archive',
      type_line: 'Artifact',
      oracle_text: '{T}: Add {C}{C}.',
      color_identity: [],
      cmc: 4,
      prices: { eur: '1.00', usd: null },
    })
    parseDecklistMock.mockReturnValue([
      { name: 'Gray Merchant of Asphodel', qty: 1 },
      { name: 'Swamp', qty: 97 },
      { name: 'Canyon Minotaur', qty: 1 },
      { name: 'Giant Spider', qty: 1 },
    ])
    detectCommandersMock.mockReturnValue(['Gray Merchant of Asphodel'])
    fetchCardsMock.mockImplementation(async (requested: Array<{ name: string }>) => {
      const catalog: Record<string, ScryfallCard> = {
        swamp: fakeCard({ name: 'Swamp', type_line: 'Basic Land — Swamp', oracle_text: '{T}: Add {B}.', cmc: 0, color_identity: ['B'] }),
        'gray merchant of asphodel': fakeCard({
          name: 'Gray Merchant of Asphodel',
          type_line: 'Creature — Zombie',
          oracle_text: 'Devotion to black.',
          color_identity: ['B'],
          cmc: 5,
        }),
        'canyon minotaur': fakeCard({
          name: 'Canyon Minotaur',
          type_line: 'Creature — Minotaur Warrior',
          oracle_text: '',
          color_identity: ['R'],
          cmc: 4,
        }),
        'giant spider': fakeCard({
          name: 'Giant Spider',
          type_line: 'Creature — Spider',
          oracle_text: 'Reach',
          color_identity: ['G'],
          cmc: 4,
        }),
        'dreamstone hedron': dreamstone,
        'hedron archive': archive,
      }
      const cards = requested.map((entry) => catalog[entry.name.toLowerCase()]).filter((card): card is ScryfallCard => card !== undefined)
      return { cards, aliases: {} }
    })
    analyzeBracketMock.mockImplementation(async (entries: Array<{ name: string }>) => {
      const names = new Set(entries.map((entry) => entry.name.toLowerCase()))
      const upgradeCount = (names.has('dreamstone hedron') ? 1 : 0) + (names.has('hedron archive') ? 1 : 0)
      if (upgradeCount >= 2) {
        return { bracket: 4, powerScore: 7, flaggedCards: [], combos: [] }
      }
      return { bracket: 2, powerScore: 3, flaggedCards: [], combos: [] }
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ name: 'Dreamstone Hedron', prices: { eur: '1.00' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ name: 'Hedron Archive', prices: { eur: '4.00' } }] }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }))

    const result = await runBracketTuner({
      decklist: '1 Gray Merchant of Asphodel\n97 Swamp\n1 Canyon Minotaur\n1 Giant Spider',
      targetBracket: 4,
      budgetEurPerCard: 20,
      ownershipMode: 'any',
    })

    expect(result.swaps.length).toBeGreaterThanOrEqual(2)
    const addedEarlier = new Set<string>()
    for (const swap of result.swaps) {
      if (swap.cut !== null) {
        expect(addedEarlier.has(swap.cut.toLowerCase())).toBe(false)
      }
      if (swap.add !== null) addedEarlier.add(swap.add.toLowerCase())
    }
  })
})
