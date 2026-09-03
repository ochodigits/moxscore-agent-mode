export function scoreTone(score: number) {
  if (score >= 75) return { color: '#19C37D', name: 'success' }
  if (score >= 50) return { color: '#F5B43C', name: 'warning' }
  return { color: '#FF5470', name: 'danger' }
}

/**
 * Human-friendly tier label shown alongside the raw number. A 62/100 is a
 * perfectly reasonable casual deck, but reads like a near-failing grade —
 * the band gives players a fairer frame for the same score.
 */
export function scoreBand(score: number): string {
  if (score >= 90) return 'Optimized'
  if (score >= 75) return 'Strong'
  if (score >= 60) return 'Solid'
  if (score >= 45) return 'Developing'
  return 'Needs Work'
}
