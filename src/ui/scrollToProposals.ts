/** Matches stacked Agent Mode layout plus typical tablet widths. */
export const COMPACT_AGENT_QUERY = '(max-width: 1024px)'

export function scrollToProposalsIfCompact(
  target: Element | null,
  media: (query: string) => Pick<MediaQueryList, 'matches'> = (query) => window.matchMedia(query),
): boolean {
  if (!target) return false
  if (!media(COMPACT_AGENT_QUERY).matches) return false
  const reduceMotion = media('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  return true
}
