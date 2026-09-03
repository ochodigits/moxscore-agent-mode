import { describe, expect, it, vi, afterEach } from 'vitest'
import { importDeckFromUrl, looksLikeDeckUrl, saveDeck } from './deckApi'

describe('deckApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects supported deck URLs but ignores pasted decklists', () => {
    expect(looksLikeDeckUrl('https://moxfield.com/decks/abc123')).toBe(true)
    expect(looksLikeDeckUrl('https://archidekt.com/decks/123456')).toBe(true)
    expect(looksLikeDeckUrl('1 Sol Ring\n1 Command Tower')).toBe(false)
  })

  it('surfaces a paste fallback message when import fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: false,
        json: async () => ({ error: "We couldn't import that deck right now. Paste the decklist below and Moxscore will still analyze it." }),
      } as Response)

    await expect(importDeckFromUrl('https://moxfield.com/decks/abc123')).rejects.toThrow('export or copy the decklist')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/import', expect.objectContaining({ method: 'POST' }))
  })

  it('imports Moxfield only through the same-origin server boundary', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decklist: '// Public Deck\n// Commander\n1 Atraxa, Praetors Voice\n\n1 Sol Ring\n1 Command Tower',
          name: 'Public Deck',
          commander: 'Atraxa, Praetors Voice',
          source: 'moxfield',
        }),
      } as Response)

    await expect(importDeckFromUrl('https://moxfield.com/decks/abc123')).resolves.toEqual({
      decklist: '// Public Deck\n// Commander\n1 Atraxa, Praetors Voice\n\n1 Sol Ring\n1 Command Tower',
      name: 'Public Deck',
      commander: 'Atraxa, Praetors Voice',
      source: 'moxfield',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/import',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('requires a deletion capability in every successful share receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ slug: 'abc123de', deletionToken: 'a'.repeat(64), expiresAt: '2026-10-29T00:00:00.000Z' }),
    } as Response)

    await expect(saveDeck({ decklist: '1 Sol Ring' })).resolves.toEqual({
      slug: 'abc123de', deletionToken: 'a'.repeat(64), expiresAt: '2026-10-29T00:00:00.000Z',
    })
  })
})
