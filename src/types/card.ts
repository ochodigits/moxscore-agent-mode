import type { CategoryKey } from '../lib/scoring.ts'

export interface ManaCurve {
  0: number
  1: number
  2: number
  3: number
  4: number
  5: number
  6: number
  '7+': number
}

// Type alias (not interface) so it stays assignable to Record<string, number>.
export type SubScores = Record<CategoryKey, number>

export interface Card {
  id: string
  name: string
  qty: number
  cmc: number
  mana_cost: string
  type_line: string
  colors: string[]
  color_identity: string[]
  oracle_text: string
  power: number | null
  keywords: string[]
  usd: string | null
  eur: string | null
  set_name: string
  image_uri: string | null
  isRamp: boolean
  isDraw: boolean
  isRemoval: boolean
  isCounterspell: boolean
  isBoardWipe: boolean
  isLand: boolean
  isProtection: boolean
  isWincon: boolean
  isCreature: boolean
  isEvasive: boolean
  isAuraOrEquipment: boolean
}

export interface AnalysisResult {
  cards: Card[]
  healthScore: number
  subScores: SubScores
  manaCurve: ManaCurve
  landCount: number
  rampCount: number
  drawCount: number
  interactionCount: number
  boardWipeCount: number
  protectionCount: number
  winconCount: number
  avgCmc: number
}
