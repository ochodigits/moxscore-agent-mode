import { useSyncExternalStore } from 'react'
import { analyzeAgentDeck } from '../engine/score.ts'
import { proposeChangesFor } from '../engine/propose.ts'
import { applyCutsAndAdds } from '../engine/apply.ts'
import { SAMPLE_DECK } from '../engine/sampleDeck.ts'
import type { AnalysisResult } from '../lib/localEngine.ts'
import type {
  AgentAnalysis,
  AgentCategories,
  AgentError,
  AgentProposal,
  ApplyResult,
  ProposeResult,
} from '../engine/types.ts'

export type AgentToolName = 'analyze_deck' | 'propose_changes' | 'apply_changes'

export interface AgentLogEntry {
  id: number
  tool: AgentToolName
  status: 'called' | 'accepted' | 'rejected'
  at: string
  detail?: string
}

export interface LastAction {
  tool: AgentToolName
  at: string
  status: 'accepted' | 'rejected'
}

export type ProposalStatus = 'pending' | 'applied' | 'rejected'

export interface PendingProposals {
  cuts: AgentProposal[]
  adds: AgentProposal[]
  weakest: ProposeResult['weakest']
  note: string
  status: ProposalStatus
}

export interface DeckStore {
  decklist: string
  analysis: AgentAnalysis | null
  engine: AnalysisResult | null
  previous: { overall: number; categories: AgentCategories } | null
  proposals: PendingProposals | null
  log: AgentLogEntry[]
  lastAction: LastAction | null
  busy: boolean
  error: string | null
}

let nextLogId = 1

const initialStore = (): DeckStore => ({
  decklist: SAMPLE_DECK,
  analysis: null,
  engine: null,
  previous: null,
  proposals: null,
  log: [],
  lastAction: null,
  busy: false,
  error: null,
})

let store: DeckStore = initialStore()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getDeckStore(): DeckStore {
  return store
}

function setStore(patch: Partial<DeckStore> | ((current: DeckStore) => DeckStore)) {
  store = typeof patch === 'function' ? patch(store) : { ...store, ...patch }
  emit()
}

export function subscribeDeckStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDeckStore(): DeckStore {
  return useSyncExternalStore(subscribeDeckStore, getDeckStore, getDeckStore)
}

function nowIso(): string {
  return new Date().toISOString()
}

function pushLog(tool: AgentToolName, status: AgentLogEntry['status'], detail?: string): AgentLogEntry {
  const entry: AgentLogEntry = { id: nextLogId++, tool, status, at: nowIso(), detail }
  setStore((current) => ({ ...current, log: [...current.log, entry] }))
  return entry
}

function setLast(tool: AgentToolName, status: LastAction['status']) {
  setStore({ lastAction: { tool, at: nowIso(), status } })
}

export function setDecklist(decklist: string) {
  setStore({ decklist, error: null })
}

export async function analyzeDeck(decklist?: string): Promise<AgentAnalysis | AgentError> {
  const text = (decklist ?? store.decklist).trim()
  if (!text) {
    const error = 'no deck loaded'
    setStore({ error })
    return { error }
  }
  pushLog('analyze_deck', 'called')
  setStore({ busy: true, error: null, ...(decklist !== undefined ? { decklist } : {}) })
  try {
    const { snapshot, result } = await analyzeAgentDeck(text)
    setStore({
      analysis: snapshot,
      engine: result,
      busy: false,
      error: null,
    })
    setLast('analyze_deck', 'accepted')
    pushLog('analyze_deck', 'accepted', `overall ${snapshot.overall}`)
    return snapshot
  } catch (err) {
    const error = err instanceof Error ? err.message : 'analysis failed'
    setStore({ busy: false, error })
    setLast('analyze_deck', 'rejected')
    pushLog('analyze_deck', 'rejected', error)
    return { error }
  }
}

export async function proposeChanges(input: {
  focus?: string[]
  budget?: 'any' | 'budget'
} = {}): Promise<ProposeResult | AgentError> {
  pushLog('propose_changes', 'called')
  if (!store.analysis || !store.engine) {
    const analyzed = await analyzeDeck()
    if ('error' in analyzed) {
      setLast('propose_changes', 'rejected')
      pushLog('propose_changes', 'rejected', analyzed.error)
      return analyzed
    }
  }
  if (!store.analysis || !store.engine) {
    const error = 'no deck loaded'
    setStore({ error })
    setLast('propose_changes', 'rejected')
    pushLog('propose_changes', 'rejected', error)
    return { error }
  }
  const proposal = proposeChangesFor(store.analysis, store.engine, input)
  setStore({
    proposals: {
      cuts: proposal.cuts,
      adds: proposal.adds,
      weakest: proposal.weakest,
      note: proposal.note,
      status: 'pending',
    },
    error: null,
  })
  setLast('propose_changes', 'accepted')
  pushLog('propose_changes', 'accepted', `${proposal.cuts.length} cuts / ${proposal.adds.length} adds`)
  return proposal
}

export async function applyChanges(input: {
  cuts: string[]
  adds: string[]
  confirm: boolean
}): Promise<ApplyResult | AgentError> {
  pushLog('apply_changes', 'called')
  if (input.confirm !== true) {
    const error = 'confirm required'
    setStore({ error })
    setLast('apply_changes', 'rejected')
    pushLog('apply_changes', 'rejected', error)
    return { error }
  }
  const text = store.decklist.trim()
  if (!text) {
    const error = 'no deck loaded'
    setStore({ error })
    setLast('apply_changes', 'rejected')
    pushLog('apply_changes', 'rejected', error)
    return { error }
  }

  let beforeAnalysis = store.analysis
  let beforeEngine = store.engine
  if (!beforeAnalysis || !beforeEngine) {
    const analyzed = await analyzeDeck()
    if ('error' in analyzed) {
      setLast('apply_changes', 'rejected')
      pushLog('apply_changes', 'rejected', analyzed.error)
      return analyzed
    }
    beforeAnalysis = store.analysis
    beforeEngine = store.engine
  }
  if (!beforeAnalysis) {
    const error = 'no deck loaded'
    setLast('apply_changes', 'rejected')
    pushLog('apply_changes', 'rejected', error)
    return { error }
  }

  const before = { overall: beforeAnalysis.overall, categories: beforeAnalysis.categories }
  const patch = applyCutsAndAdds(store.decklist, input.cuts, input.adds)

  const namesInDeck = new Set(
    (beforeEngine?.entries ?? []).map((card) => card.name.toLowerCase()),
  )
  for (const cut of input.cuts) {
    if (!namesInDeck.has(cut.trim().toLowerCase()) && !patch.applied_cuts.some((n) => n.toLowerCase() === cut.trim().toLowerCase())) {
      if (!patch.skipped.some((n) => n.toLowerCase() === cut.trim().toLowerCase())) {
        patch.skipped.push(cut)
      }
    }
  }
  if (input.cuts.length > 0 && patch.applied_cuts.length === 0 && input.adds.length === 0) {
    const error = 'card not in deck'
    setStore({ error })
    setLast('apply_changes', 'rejected')
    pushLog('apply_changes', 'rejected', error)
    return { error }
  }

  setStore({ decklist: patch.nextDecklist, busy: true, error: null })
  try {
    const { snapshot, result } = await analyzeAgentDeck(patch.nextDecklist)
    const after = { overall: snapshot.overall, categories: snapshot.categories }
    setStore({
      analysis: snapshot,
      engine: result,
      previous: before,
      busy: false,
      proposals: store.proposals
        ? { ...store.proposals, status: 'applied' }
        : null,
    })
    const applied: ApplyResult = {
      applied_cuts: patch.applied_cuts,
      applied_adds: patch.applied_adds,
      skipped: patch.skipped,
      before,
      after,
      delta: after.overall - before.overall,
    }
    setLast('apply_changes', 'accepted')
    pushLog('apply_changes', 'accepted', `${before.overall} → ${after.overall}`)
    return applied
  } catch (err) {
    const error = err instanceof Error ? err.message : 'apply failed'
    setStore({ busy: false, error })
    setLast('apply_changes', 'rejected')
    pushLog('apply_changes', 'rejected', error)
    return { error }
  }
}

export function rejectProposals(): void {
  if (!store.proposals) return
  pushLog('apply_changes', 'called')
  setStore({
    proposals: { ...store.proposals, status: 'rejected' },
    error: null,
  })
  setLast('apply_changes', 'rejected')
  pushLog('apply_changes', 'rejected', 'human rejected')
}

export function resetDemo(): void {
  nextLogId = 1
  store = initialStore()
  emit()
}

export function toToolJson(value: unknown): string {
  return JSON.stringify(value)
}
