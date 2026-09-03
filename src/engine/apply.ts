import { parseDecklist, detectCommanders } from '../lib/parser.ts'

export interface ApplyPatch {
  nextDecklist: string
  applied_cuts: string[]
  applied_adds: string[]
  skipped: string[]
}

function parseLine(line: string): { name: string; qty: number } | null {
  const parsed = parseDecklist(line)
  const first = parsed[0]
  return first ?? null
}

function namesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Apply accepted cuts/adds to the raw decklist text. Never cuts the commander.
 * Keeps original comments and unmatched lines intact.
 */
export function applyCutsAndAdds(decklist: string, cuts: string[], adds: string[]): ApplyPatch {
  const commanders = detectCommanders(decklist).map((name) => name.toLowerCase())
  const remainingCuts = cuts.map((name) => name.trim()).filter(Boolean)
  const applied_cuts: string[] = []
  const skipped: string[] = []
  const lines = decklist.split(/\r?\n/)

  const nextLines: string[] = []
  for (const line of lines) {
    const parsed = parseLine(line)
    if (!parsed) {
      nextLines.push(line)
      continue
    }
    if (commanders.includes(parsed.name.toLowerCase())) {
      nextLines.push(line)
      continue
    }
    const cutIndex = remainingCuts.findIndex((name) => namesEqual(name, parsed.name))
    if (cutIndex < 0) {
      nextLines.push(line)
      continue
    }
    const cutName = remainingCuts[cutIndex] ?? parsed.name
    remainingCuts.splice(cutIndex, 1)
    applied_cuts.push(parsed.name)
    if (parsed.qty > 1) {
      nextLines.push(line.replace(/\b\d+\b/, String(parsed.qty - 1)))
    }
    void cutName
  }

  for (const leftover of remainingCuts) {
    skipped.push(leftover)
  }

  const existing = new Set(parseDecklist(nextLines.join('\n')).map((e) => e.name.toLowerCase()))
  const applied_adds: string[] = []
  const addLines: string[] = []
  for (const raw of adds) {
    const name = raw.trim()
    if (!name) continue
    if (existing.has(name.toLowerCase())) {
      skipped.push(name)
      continue
    }
    existing.add(name.toLowerCase())
    applied_adds.push(name)
    addLines.push(`1 ${name}`)
  }

  let nextDecklist = nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  if (addLines.length > 0) {
    nextDecklist = `${nextDecklist}\n\n// Agent Mode adds\n${addLines.join('\n')}\n`
  } else {
    nextDecklist = `${nextDecklist}\n`
  }

  return { nextDecklist, applied_cuts, applied_adds, skipped }
}
