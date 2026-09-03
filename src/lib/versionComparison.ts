export interface SavedDeckVersion {
  id: string
  version_number: number
  analysis_snapshot: Record<string, unknown>
  analyzer_version: string
  curated_data_version: string
  created_at: string
}

interface SnapshotEntry { name?: unknown; qty?: unknown }

interface ComparisonSnapshot {
  score: number | null
  subScores: Record<string, number>
  curve: Record<string, number>
  bracket: number | null
  entries: SnapshotEntry[]
}

export interface VersionComparison {
  older: SavedDeckVersion
  newer: SavedDeckVersion
  scoreDelta: number | null
  subScoreDeltas: Record<string, number>
  curveDeltas: Record<string, number>
  bracketDelta: number | null
  addedCards: Array<{ name: string; quantity: number }>
  removedCards: Array<{ name: string; quantity: number }>
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    const parsed = number(candidate)
    return parsed === null ? [] : [[key, parsed]]
  }))
}

function parseSnapshot(value: Record<string, unknown>): ComparisonSnapshot {
  const bracketValue = typeof value.bracket === 'object' && value.bracket !== null && !Array.isArray(value.bracket)
    ? number((value.bracket as Record<string, unknown>).bracket)
    : null
  return {
    score: number(value.score),
    subScores: numberRecord(value.subScores),
    curve: numberRecord(value.curve),
    bracket: bracketValue,
    entries: Array.isArray(value.entries) ? value.entries.filter((entry): entry is SnapshotEntry => typeof entry === 'object' && entry !== null) : [],
  }
}

function quantities(entries: SnapshotEntry[]): Map<string, { name: string; quantity: number }> {
  const result = new Map<string, { name: string; quantity: number }>()
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue
    const quantity = number(entry.qty)
    if (quantity === null || quantity <= 0) continue
    const name = entry.name.trim()
    const key = name.toLocaleLowerCase('en-US')
    const current = result.get(key)
    result.set(key, { name, quantity: (current?.quantity ?? 0) + quantity })
  }
  return result
}

function deltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]))
}

/** Deterministic comparison of two immutable analysis snapshots. */
export function compareVersions(older: SavedDeckVersion, newer: SavedDeckVersion): VersionComparison {
  const before = parseSnapshot(older.analysis_snapshot)
  const after = parseSnapshot(newer.analysis_snapshot)
  const oldCards = quantities(before.entries)
  const newCards = quantities(after.entries)
  const addedCards: VersionComparison['addedCards'] = []
  const removedCards: VersionComparison['removedCards'] = []

  for (const [key, card] of newCards) {
    const delta = card.quantity - (oldCards.get(key)?.quantity ?? 0)
    if (delta > 0) addedCards.push({ name: card.name, quantity: delta })
  }
  for (const [key, card] of oldCards) {
    const delta = card.quantity - (newCards.get(key)?.quantity ?? 0)
    if (delta > 0) removedCards.push({ name: card.name, quantity: delta })
  }

  return {
    older,
    newer,
    scoreDelta: before.score === null || after.score === null ? null : after.score - before.score,
    subScoreDeltas: deltas(before.subScores, after.subScores),
    curveDeltas: deltas(before.curve, after.curve),
    bracketDelta: before.bracket === null || after.bracket === null ? null : after.bracket - before.bracket,
    addedCards: addedCards.sort((a, b) => a.name.localeCompare(b.name)),
    removedCards: removedCards.sort((a, b) => a.name.localeCompare(b.name)),
  }
}
