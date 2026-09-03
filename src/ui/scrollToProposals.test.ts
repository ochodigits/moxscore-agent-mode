import { describe, expect, it, vi } from 'vitest'
import { COMPACT_AGENT_QUERY, scrollToProposalsIfCompact } from './scrollToProposals.ts'

function mediaFor(matches: Record<string, boolean>) {
  return (query: string) => ({ matches: Boolean(matches[query]) })
}

describe('scrollToProposalsIfCompact', () => {
  it('scrolls on compact viewports', () => {
    const target = { scrollIntoView: vi.fn() } as unknown as Element
    const scrolled = scrollToProposalsIfCompact(
      target,
      mediaFor({ [COMPACT_AGENT_QUERY]: true, '(prefers-reduced-motion: reduce)': false }),
    )
    expect(scrolled).toBe(true)
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('does not scroll on desktop widths', () => {
    const target = { scrollIntoView: vi.fn() } as unknown as Element
    const scrolled = scrollToProposalsIfCompact(target, mediaFor({ [COMPACT_AGENT_QUERY]: false }))
    expect(scrolled).toBe(false)
    expect(target.scrollIntoView).not.toHaveBeenCalled()
  })

  it('uses instant scrolling when reduced motion is preferred', () => {
    const target = { scrollIntoView: vi.fn() } as unknown as Element
    scrollToProposalsIfCompact(
      target,
      mediaFor({ [COMPACT_AGENT_QUERY]: true, '(prefers-reduced-motion: reduce)': true }),
    )
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })
})
