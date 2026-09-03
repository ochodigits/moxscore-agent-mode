import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDecklist, detectCommanders } from './parser.ts'
import { analyzeBracket, type BracketDeckEntry } from './bracketEngine.ts'
import type { ScryfallCard } from './scryfall.ts'
import type { SpellbookClient } from './spellbook.ts'
import expected from '../../fixtures/expected.json'

// import.meta.url is an http: URL under the jsdom test environment, so
// locate fixtures from the repo root vitest runs in instead.
const FIXTURES = resolve(process.cwd(), 'fixtures')

function loadFixture(name: string): BracketDeckEntry[] {
  const text = readFileSync(resolve(FIXTURES, `${name}.txt`), 'utf8')
  const cards = JSON.parse(readFileSync(resolve(FIXTURES, `${name}.cards.json`), 'utf8')) as Record<
    string,
    ScryfallCard
  >
  const commanders = new Set(detectCommanders(text).map((n) => n.toLowerCase()))
  return parseDecklist(text).map((e) => ({
    name: e.name,
    quantity: e.qty,
    scryfallData: cards[e.name],
    isCommander: commanders.has(e.name.toLowerCase()),
  }))
}

const noCombos: SpellbookClient = { findCombos: async () => [] }
const kinnanCombo: SpellbookClient = {
  findCombos: async () => [['Kinnan, Bonder Prodigy', 'Basalt Monolith']],
}
const failingClient: SpellbookClient = {
  findCombos: async () => {
    throw new Error('network down')
  },
}

describe('fixtures load cleanly', () => {
  it.each(['precon', 'upgraded', 'cedh'])('%s resolves every card', (name) => {
    const entries = loadFixture(name)
    expect(entries.reduce((s, e) => s + e.quantity, 0)).toBe(100)
    expect(entries.filter((e) => e.scryfallData === undefined)).toEqual([])
  })
})

describe('analyzeBracket — golden decks', () => {
  it('precon-power deck lands in bracket 2', async () => {
    const result = await analyzeBracket(loadFixture('precon'), { spellbook: noCombos })
    expect(result.bracket).toBe(expected.precon.bracket)
    expect(result.flaggedCards.filter((f) => f.reason === 'gameChanger')).toHaveLength(0)
    expect(result.hardFlags.find((f) => f.code === 'gameChangers')).toBeUndefined()
    expect(result.softSignals.fastManaCount).toBe(expected.precon.fastMana)
    expect(result.softSignals.tutorCount).toBe(expected.precon.tutors)
    expect(result.powerScore).toBeLessThanOrEqual(expected.precon.powerScoreMax)
    expect(result.comboCheck).toBe('ok')
  })

  it('upgraded deck with exactly 3 Game Changers lands in bracket 3', async () => {
    const result = await analyzeBracket(loadFixture('upgraded'), { spellbook: noCombos })
    expect(result.bracket).toBe(expected.upgraded.bracket)
    const gcs = result.flaggedCards.filter((f) => f.reason === 'gameChanger')
    expect(gcs.map((f) => f.card).sort()).toEqual(['Ancient Tomb', 'Cyclonic Rift', 'Rhystic Study'])
    expect(result.powerScore).toBeLessThanOrEqual(expected.upgraded.powerScoreMax)
  })

  it('cEDH deck lands in bracket 5', async () => {
    const result = await analyzeBracket(loadFixture('cedh'), { spellbook: kinnanCombo })
    expect(result.bracket).toBe(expected.cedh.bracket)
    expect(result.flaggedCards.filter((f) => f.reason === 'gameChanger')).toHaveLength(expected.cedh.gameChangers)
    expect(result.powerScore).toBeGreaterThanOrEqual(expected.cedh.powerScoreMin)
    expect(result.combos).toHaveLength(1)
    expect(result.combos[0]?.early).toBe(true)
    expect(result.hardFlags.find((f) => f.code === 'earlyCombos')).toBeDefined()
  })
})

describe('analyzeBracket — hard rules', () => {
  it('an early combo pushes an otherwise-bracket-3 deck past bracket 3', async () => {
    const result = await analyzeBracket(loadFixture('upgraded'), {
      spellbook: { findCombos: async () => [['Rhystic Study', 'Sol Ring']] },
    })
    // Fake combo: combined MV 4 (≤ 7) → early → hard rules fail through bracket 3.
    expect(result.bracket).toBeGreaterThanOrEqual(4)
  })

  it('a late combo (combined MV > 7) keeps bracket 3 available', async () => {
    const result = await analyzeBracket(loadFixture('upgraded'), {
      spellbook: { findCombos: async () => [['Utvara Hellkite', 'Lathliss, Dragon Queen']] },
    })
    expect(result.combos[0]?.early).toBe(false)
    expect(result.bracket).toBe(3)
  })

  it('4+ Game Changers exceed bracket 3', async () => {
    const entries = loadFixture('upgraded')
    const cedhCards = JSON.parse(readFileSync(resolve(FIXTURES, 'cedh.cards.json'), 'utf8')) as Record<
      string,
      ScryfallCard
    >
    entries.push({ name: 'Force of Will', quantity: 1, scryfallData: cedhCards['Force of Will'] })
    const result = await analyzeBracket(entries, { spellbook: noCombos })
    expect(result.bracket).toBeGreaterThanOrEqual(4)
  })

  it('bracket never goes below 2 and power stays within 1–10', async () => {
    const result = await analyzeBracket([], { spellbook: noCombos })
    expect(result.bracket).toBe(2)
    expect(result.powerScore).toBeGreaterThanOrEqual(1)
    expect(result.powerScore).toBeLessThanOrEqual(10)
  })
})

describe('analyzeBracket — combo lookup robustness', () => {
  it('reports comboCheck failed but still brackets the deck when Spellbook is down', async () => {
    const result = await analyzeBracket(loadFixture('cedh'), { spellbook: failingClient })
    expect(result.comboCheck).toBe('failed')
    expect(result.bracket).toBe(5) // power score alone carries it
  })

  it('skips combo detection when no client is provided', async () => {
    const result = await analyzeBracket(loadFixture('precon'))
    expect(result.comboCheck).toBe('skipped')
    expect(result.bracket).toBe(2)
  })
})

describe('flaggedCards ranking', () => {
  it('ranks combo pieces and Game Changers above fast mana and tutors', async () => {
    const result = await analyzeBracket(loadFixture('cedh'), { spellbook: kinnanCombo })
    const impacts = result.flaggedCards.map((f) => f.bracketImpact)
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a))
    expect(result.flaggedCards[0]?.reason).toBe('earlyCombo')
  })
})
