export const AGENT_CATEGORIES = ['ramp', 'draw', 'interaction', 'curve', 'wincons'] as const
export type AgentCategory = (typeof AGENT_CATEGORIES)[number]

export type AgentSeverity = 'high' | 'medium' | 'low'

export interface AgentWeakness {
  category: AgentCategory
  severity: AgentSeverity
  detail: string
}

export interface AgentCategories {
  ramp: number
  draw: number
  interaction: number
  curve: number
  wincons: number
}

export interface AgentCounts {
  ramp: number
  draw: number
  interaction: number
  lands: number
  avg_cmc: number
}

export interface AgentAnalysis {
  commander: string
  card_count: number
  overall: number
  categories: AgentCategories
  counts: AgentCounts
  weaknesses: AgentWeakness[]
  unresolved: string[]
  diagnosis: string[]
}

export interface AgentProposal {
  name: string
  reason: string
  helps: AgentCategory
}

export interface ProposeResult {
  overall: number
  weakest: AgentCategory[]
  cuts: AgentProposal[]
  adds: AgentProposal[]
  note: string
}

export interface ApplyResult {
  applied_cuts: string[]
  applied_adds: string[]
  skipped: string[]
  before: { overall: number; categories: AgentCategories }
  after: { overall: number; categories: AgentCategories }
  delta: number
}

export interface AgentError {
  error: string
}

export function isAgentError(value: unknown): value is AgentError {
  return Boolean(value && typeof value === 'object' && 'error' in value && typeof (value as AgentError).error === 'string')
}
