import { describe, expect, it } from 'vitest'
import { MAX_COLLECTION_ROWS, parseCollection } from './collectionParser'

describe('collection parser', () => {
  it('parses and combines quoted ManaBox CSV rows', () => {
    const result = parseCollection('Name,Quantity,Set Code\n"Atraxa, Praetors Voice",1,2X2\nSol Ring,2,C21')
    expect(result.source).toBe('manabox-csv')
    expect(result.cards).toEqual([
      { name: 'Atraxa, Praetors Voice', quantity: 1 },
      { name: 'Sol Ring', quantity: 2 },
    ])
  })

  it('accepts generic headers and reports invalid rows without dropping valid cards', () => {
    const result = parseCollection('Card Name,Qty\nSol Ring,1\nIsland,nope\n,2')
    expect(result.source).toBe('generic-csv')
    expect(result.cards).toEqual([{ name: 'Sol Ring', quantity: 1 }])
    expect(result.errors).toEqual([
      { row: 3, message: 'Quantity must be a whole number between 1 and 1000.' },
      { row: 4, message: 'Missing card name.' },
    ])
  })

  it('parses plain-text count prefixes, suffixes, comments, and bare card names', () => {
    const result = parseCollection('# collection\n2 Sol Ring\nArcane Signet x1\nIsland')
    expect(result).toMatchObject({
      source: 'text',
      cards: [
        { name: 'Sol Ring', quantity: 2 },
        { name: 'Arcane Signet', quantity: 1 },
        { name: 'Island', quantity: 1 },
      ],
      errors: [],
    })
  })

  it('combines duplicate names case-insensitively', () => {
    expect(parseCollection('Name,Quantity\nSol Ring,1\nsol ring,2').cards).toEqual([{ name: 'Sol Ring', quantity: 3 }])
  })

  it('rejects oversized row counts before parsing user content', () => {
    const text = Array.from({ length: MAX_COLLECTION_ROWS + 2 }, () => 'Sol Ring').join('\n')
    expect(parseCollection(text).errors).toEqual([{ row: 0, message: 'Collection has more than 10,000 rows.' }])
  })
})
