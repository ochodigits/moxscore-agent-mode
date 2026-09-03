import { describe, it, expect } from 'vitest'
import { parseDecklist, detectCommanders } from './parser.ts'

describe('parseDecklist', () => {
  it('parses "1 CardName" format', () => {
    expect(parseDecklist('1 Sol Ring')).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('parses "1x CardName" format', () => {
    expect(parseDecklist('1x Sol Ring')).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('parses "CardName x1" trailing format', () => {
    expect(parseDecklist('Sol Ring x1')).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('parses quantities greater than 1', () => {
    expect(parseDecklist('10 Forest')).toEqual([{ name: 'Forest', qty: 10 }])
  })

  it('parses a bare card name with no quantity as qty 1', () => {
    expect(parseDecklist("Atraxa, Praetors' Voice")).toEqual([
      { name: "Atraxa, Praetors' Voice", qty: 1 },
    ])
  })

  it('skips blank lines', () => {
    expect(parseDecklist('1 Sol Ring\n\n1 Command Tower')).toEqual([
      { name: 'Sol Ring', qty: 1 },
      { name: 'Command Tower', qty: 1 },
    ])
  })

  it('skips // section headers', () => {
    const input = "// Commander\n1 Atraxa, Praetors' Voice\n// Lands\n1 Command Tower"
    expect(parseDecklist(input)).toEqual([
      { name: "Atraxa, Praetors' Voice", qty: 1 },
      { name: 'Command Tower', qty: 1 },
    ])
  })

  it('strips *CMDR* prefix marker', () => {
    expect(parseDecklist("*CMDR* 1 Atraxa, Praetors' Voice")).toEqual([
      { name: "Atraxa, Praetors' Voice", qty: 1 },
    ])
  })

  it('strips *CMDR* suffix marker', () => {
    expect(parseDecklist("1 Atraxa, Praetors' Voice *CMDR*")).toEqual([
      { name: "Atraxa, Praetors' Voice", qty: 1 },
    ])
  })

  it('excludes sideboard cards from the main deck', () => {
    const input = "1 Sol Ring\nSideboard\n1 Tormod's Crypt"
    expect(parseDecklist(input)).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('excludes sideboard cards after "Sideboard:" with colon', () => {
    const input = "1 Sol Ring\nSideboard:\n1 Tormod's Crypt"
    expect(parseDecklist(input)).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('excludes sideboard cards after a "// Sideboard" comment header', () => {
    const input = "1 Sol Ring\n// Sideboard\n1 Tormod's Crypt"
    expect(parseDecklist(input)).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('resumes main-deck parsing when a new section follows the sideboard', () => {
    const input = "Sideboard\n1 Tormod's Crypt\nDeck\n1 Sol Ring"
    expect(parseDecklist(input)).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('strips trailing set code and collector number (Moxfield/Arena exports)', () => {
    expect(parseDecklist('1 Sol Ring (C21) 123')).toEqual([{ name: 'Sol Ring', qty: 1 }])
    expect(parseDecklist('1 Lightning Bolt (2X2) 117')).toEqual([{ name: 'Lightning Bolt', qty: 1 }])
    expect(parseDecklist('1 Sol Ring (C21)')).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('strips foil/etched markers', () => {
    expect(parseDecklist('1 Sol Ring (C21) 123 *F*')).toEqual([{ name: 'Sol Ring', qty: 1 }])
    expect(parseDecklist('1 Sol Ring *E*')).toEqual([{ name: 'Sol Ring', qty: 1 }])
  })

  it('skips plain export header lines (Deck / Commander / About)', () => {
    const input = 'About\nName My Deck\nCommander\n1 Atraxa, Praetors\' Voice\nDeck\n1 Sol Ring'
    expect(parseDecklist(input)).toEqual([
      { name: 'Name My Deck', qty: 1 },
      { name: "Atraxa, Praetors' Voice", qty: 1 },
      { name: 'Sol Ring', qty: 1 },
    ])
  })

  it('parses a realistic multi-card decklist with mixed sections', () => {
    const input = `// Commander
1 Atraxa, Praetors' Voice
// Ramp
1x Sol Ring
1x Arcane Signet
// Lands
10 Forest
5 Plains
`
    expect(parseDecklist(input)).toEqual([
      { name: "Atraxa, Praetors' Voice", qty: 1 },
      { name: 'Sol Ring', qty: 1 },
      { name: 'Arcane Signet', qty: 1 },
      { name: 'Forest', qty: 10 },
      { name: 'Plains', qty: 5 },
    ])
  })

  it('handles Windows-style CRLF line endings', () => {
    expect(parseDecklist('1 Sol Ring\r\n1 Command Tower\r\n')).toEqual([
      { name: 'Sol Ring', qty: 1 },
      { name: 'Command Tower', qty: 1 },
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseDecklist('')).toEqual([])
  })

  it('returns an empty array for input with only headers and blank lines', () => {
    expect(parseDecklist('// Commander\n\n// Lands\n\n')).toEqual([])
  })
})

describe('detectCommanders', () => {
  it('finds a single commander under a "// Commander" header', () => {
    expect(detectCommanders("// Commander\n1 Atraxa, Praetors' Voice\n\n1 Sol Ring")).toEqual([
      "Atraxa, Praetors' Voice",
    ])
  })

  it('collects partner commanders — every card until the blank line', () => {
    const input = '// Commander\n1 Thrasios, Triton Hero\n1 Tymna the Weaver\n\n1 Sol Ring'
    expect(detectCommanders(input)).toEqual(['Thrasios, Triton Hero', 'Tymna the Weaver'])
  })

  it('finds commanders marked with *CMDR*', () => {
    expect(detectCommanders("1 Atraxa, Praetors' Voice *CMDR*\n1 Sol Ring")).toEqual([
      "Atraxa, Praetors' Voice",
    ])
  })

  it('supports plain "Commander" headers from Arena exports', () => {
    expect(detectCommanders('Commander\n1 The Ur-Dragon\n\nDeck\n1 Sol Ring')).toEqual(['The Ur-Dragon'])
  })

  it('does not treat a deck *named* Commander-something as a commander section', () => {
    expect(detectCommanders('// Commander Chaos Deck\n1 Sol Ring\n1 Arcane Signet')).toEqual([])
  })

  it('strips set codes from commander names', () => {
    expect(detectCommanders('// Commander\n1 The Ur-Dragon (CMM) 361\n')).toEqual(['The Ur-Dragon'])
  })

  it('returns an empty array when no commander is declared', () => {
    expect(detectCommanders('1 Sol Ring\n1 Command Tower')).toEqual([])
  })
})
