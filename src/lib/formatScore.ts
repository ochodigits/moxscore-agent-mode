/** Display a health or category score with exactly two decimal places. */
export function formatScore(value: number): string {
  return value.toFixed(2)
}

/** Numeric 2-decimal rounding for JSON and tool payloads. Does not change scoring math. */
export function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}
