import { describe, expect, it, beforeEach } from 'vitest'
import { analyze } from '../lib/localEngine.ts'
import { buildAgentSnapshot } from './score.ts'
import { proposeChangesFor } from './propose.ts'
import { applyCutsAndAdds } from './apply.ts'
import { SAMPLE_DECK } from './sampleDeck.ts'
import { parseDecklist } from './parse.ts'
import { AGENT_TOOLS } from '../webmcp/registerTools.ts'
import {
  analyzeDeck,
  applyChanges,
  proposeChanges,
  resetDemo,
  getDeckStore,
} from '../state/deckStore.ts'

function snapshotOf(text: string) {
  return buildAgentSnapshot(analyze(text))
}

describe('Agent Mode analyzer', () => {
  it('is deterministic for the same list', () => {
    const a = snapshotOf(SAMPLE_DECK)
    const b = snapshotOf(SAMPLE_DECK)
    expect(a).toEqual(b)
  })

  it('scores the sample deck in the mid 55–70 band with weak draw', () => {
    const snap = snapshotOf(SAMPLE_DECK)
    expect(snap.card_count).toBe(100)
    expect(snap.commander).toBe('The Ur-Dragon')
    expect(snap.overall).toBeGreaterThanOrEqual(55)
    expect(snap.overall).toBeLessThanOrEqual(70)
    expect(snap.categories.draw).toBeLessThan(snap.categories.ramp)
    expect(snap.weaknesses.some((w) => w.category === 'draw' || w.category === 'curve')).toBe(true)
  })

  it('never silently drops unresolved names', () => {
    const snap = snapshotOf('1 Totally Fake Cardname XYZ\n1 Sol Ring')
    expect(snap.unresolved.length).toBeGreaterThan(0)
  })
})

describe('propose_changes', () => {
  it('does not mutate the decklist and returns at most 3 cuts and 3 adds', () => {
    const engine = analyze(SAMPLE_DECK)
    const analysis = buildAgentSnapshot(engine)
    const proposal = proposeChangesFor(analysis, engine)
    expect(proposal.cuts.length).toBeLessThanOrEqual(3)
    expect(proposal.adds.length).toBeLessThanOrEqual(3)
    expect(proposal.cuts.some((c) => c.name === 'The Ur-Dragon')).toBe(false)
    expect(SAMPLE_DECK).toContain('The Ur-Dragon')
  })
})

describe('apply_changes patch', () => {
  it('never cuts the commander and appends adds', () => {
    const patch = applyCutsAndAdds(SAMPLE_DECK, ['The Ur-Dragon', 'Utvara Hellkite'], ['Rhystic Study'])
    expect(patch.applied_cuts).toEqual(['Utvara Hellkite'])
    expect(patch.applied_adds).toEqual(['Rhystic Study'])
    expect(patch.nextDecklist).toContain('The Ur-Dragon')
    expect(patch.nextDecklist).not.toMatch(/^1 Utvara Hellkite$/m)
    expect(patch.nextDecklist).toContain('1 Rhystic Study')
  })
})

describe('shared store actions', () => {
  beforeEach(() => {
    resetDemo()
  })

  it('analyzeDeck without an argument uses the page deck and writes that same JSON into the scoreboard store', async () => {
    const fromButton = await analyzeDeck()
    expect(fromButton).toEqual(getDeckStore().analysis)
    if ('error' in fromButton) throw new Error(fromButton.error)
    expect(fromButton.commander).toBe('The Ur-Dragon')
    expect(fromButton.card_count).toBe(100)
  })

  it('rejects apply_changes when confirm is not true', async () => {
    await analyzeDeck()
    const result = await applyChanges({ cuts: ['Utvara Hellkite'], adds: ['Rhystic Study'], confirm: false })
    expect(result).toEqual({ error: 'confirm required' })
    expect(getDeckStore().decklist).toBe(SAMPLE_DECK)
  })

  it('apply_changes with confirm=true updates the textarea and overall score', async () => {
    const before = await analyzeDeck()
    if ('error' in before) throw new Error(before.error)
    const proposal = await proposeChanges()
    if ('error' in proposal) throw new Error(proposal.error)
    const applied = await applyChanges({
      cuts: proposal.cuts.map((c) => c.name),
      adds: proposal.adds.map((a) => a.name),
      confirm: true,
    })
    if ('error' in applied) throw new Error(applied.error)
    expect(getDeckStore().decklist).not.toBe(SAMPLE_DECK)
    expect(getDeckStore().analysis?.overall).toBe(applied.after.overall)
    expect(applied.before.overall).toBe(before.overall)
    expect(applied.after.overall).toBeGreaterThan(applied.before.overall)
    expect(applied.applied_adds.length + applied.applied_cuts.length).toBeGreaterThan(0)
  })
})

describe('WebMCP catalog', () => {
  it('registers exactly three snake_case tools', () => {
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual(['analyze_deck', 'propose_changes', 'apply_changes'])
  })
})

describe('parser used by the workspace', () => {
  it('counts the sample near 100 including commander', () => {
    const qty = parseDecklist(SAMPLE_DECK).reduce((sum, entry) => sum + entry.qty, 0)
    expect(qty).toBe(100)
  })
})
