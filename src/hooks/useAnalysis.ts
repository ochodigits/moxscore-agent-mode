import { useQuery } from '@tanstack/react-query'
import type { AnalysisResult } from '../lib/localEngine.ts'
import { runAnalysis } from '../lib/scryfallEngine.ts'
import { DEFAULT_FORMAT, type MtgFormat } from '../lib/formats.ts'

export function useAnalysis(decklist: string, format: MtgFormat = DEFAULT_FORMAT) {
  return useQuery<AnalysisResult, Error>({
    queryKey: ['analysis', decklist, format.id],
    queryFn: () => runAnalysis(decklist, format),
    enabled: decklist.trim().length > 0,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  })
}
