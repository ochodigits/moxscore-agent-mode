import type { PodDeckAnalysis } from './scryfallEngine.ts'

export interface PodCheckInput {
  input: string
}

export interface PodCheckOutcome {
  input: string
  analysis: PodDeckAnalysis | null
  error: string | null
}

export interface PodCheckDependencies {
  /** Resolve/import and analyze one input in the calling transport. */
  analyze(input: string): Promise<PodDeckAnalysis>
}

/**
 * Transport-neutral Pod Check orchestration. It intentionally knows nothing
 * about React, HTTP responses, Discord payloads, or persistence.
 */
export async function runPodCheck(
  inputs: PodCheckInput[],
  dependencies: PodCheckDependencies,
): Promise<PodCheckOutcome[]> {
  if (inputs.length < 2 || inputs.length > 4) {
    throw new Error('Pod Check needs 2–4 decks.')
  }
  return Promise.all(inputs.map(async ({ input }): Promise<PodCheckOutcome> => {
    const trimmed = input.trim()
    if (!trimmed) return { input, analysis: null, error: null }
    try {
      return { input, analysis: await dependencies.analyze(trimmed), error: null }
    } catch (cause) {
      return { input, analysis: null, error: cause instanceof Error ? cause.message : 'Analysis failed.' }
    }
  }))
}
