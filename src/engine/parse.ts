export { parseDecklist, detectCommanders, type DeckEntry } from '../lib/parser.ts'

import { parseDecklist, detectCommanders } from '../lib/parser.ts'

export function deckMeta(text: string): { commander: string; card_count: number; names: string[] } {
  const entries = parseDecklist(text)
  const commanders = detectCommanders(text)
  return {
    commander: commanders[0] ?? entries[0]?.name ?? 'Unknown',
    card_count: entries.reduce((sum, entry) => sum + entry.qty, 0),
    names: entries.map((entry) => entry.name),
  }
}
