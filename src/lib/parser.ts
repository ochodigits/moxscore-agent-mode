export interface DeckEntry {
  name: string
  qty: number
}

// Plain (un-commented) section headers emitted by Moxfield / Arena / Archidekt
// text exports. These must never be parsed as card names.
const PLAIN_HEADER_RE =
  /^(deck|commanders?|companion|sideboard|maybeboard|considering|about|tokens?|attractions|stickers)\s*:?\s*$/i

/**
 * Strip printing metadata that Moxfield/Arena exports append to a card name:
 * foil/etched markers ("*F*", "*E*"), and trailing set code + collector
 * number ("Sol Ring (C21) 123" or "Sol Ring (C21)").
 */
function cleanCardName(name: string): string {
  return name
    .replace(/\s*\*[FE]\*\s*$/i, '')
    .replace(/\s*\([A-Z0-9]{2,6}\)(\s+[A-Za-z0-9★-]+)?\s*$/, '')
    .trim()
}

export function parseDecklist(text: string): DeckEntry[] {
  const results: DeckEntry[] = []
  let inSideboard = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()

    if (line.length === 0) continue
    if (line.startsWith('//')) {
      inSideboard = /^\/\/\s*sideboard\b/i.test(line)
      continue
    }
    if (PLAIN_HEADER_RE.test(line)) {
      inSideboard = /^sideboard/i.test(line)
      continue
    }
    // Sideboard cards are not part of the main deck — skip them entirely.
    if (inSideboard) continue

    const stripped = line
      .replace(/^\*CMDR\*\s*/i, '')
      .replace(/\s*\*CMDR\*$/i, '')
      .trim()

    // Leading quantity: "1 Sol Ring" or "1x Sol Ring"
    const leadMatch = stripped.match(/^(\d+)x?\s+(.+)$/)
    if (leadMatch?.[1] !== undefined && leadMatch[2] !== undefined) {
      results.push({ name: cleanCardName(leadMatch[2]), qty: parseInt(leadMatch[1], 10) })
      continue
    }

    // Trailing quantity: "Sol Ring x1"
    const trailMatch = stripped.match(/^(.+?)\s+x(\d+)$/i)
    if (trailMatch?.[1] !== undefined && trailMatch[2] !== undefined) {
      results.push({ name: cleanCardName(trailMatch[1]), qty: parseInt(trailMatch[2], 10) })
      continue
    }

    // Fallback: bare card name, qty 1
    if (stripped.length > 0) {
      results.push({ name: cleanCardName(stripped), qty: 1 })
    }
  }

  return results
}

/**
 * Collect every commander named in the decklist — supports partner /
 * background pairs. Sources, in priority order:
 *  - "*CMDR*" markers on individual lines
 *  - a "// Commander" (or plain "Commander") section header: every card line
 *    until the next blank line or header belongs to the command zone.
 */
export function detectCommanders(text: string): string[] {
  const out: string[] = []
  let inSection = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) {
      inSection = false
      continue
    }

    const marked =
      line.match(/^(?:\d+x?\s+)?(.+?)\s+\*CMDR\*\s*$/i) ?? line.match(/^\*CMDR\*\s*(?:\d+x?\s+)?(.+)$/i)
    if (marked?.[1] !== undefined) {
      out.push(cleanCardName(marked[1]))
      continue
    }

    if (line.startsWith('//')) {
      // Only an exact "// Commander(s)" header opens the section — a deck
      // *named* "Commander Chaos" must not swallow the mainboard.
      inSection = /^\/\/\s*commanders?\s*:?\s*$/i.test(line)
      continue
    }
    if (PLAIN_HEADER_RE.test(line)) {
      inSection = /^commanders?\s*:?\s*$/i.test(line)
      continue
    }

    if (inSection) {
      const m = line.match(/^(\d+)x?\s+(.+)$/)
      out.push(cleanCardName(m?.[2] ?? line))
    }
  }

  return [...new Set(out)]
}
