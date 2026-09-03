export interface MtgFormat {
  id: string
  name: string
  group: string
  deckLimit: number
  isCommander: boolean
}

const COMMANDER: MtgFormat = { id: 'commander', name: 'Commander', group: 'Multiplayer', deckLimit: 100, isCommander: true }

export const FORMATS: MtgFormat[] = [
  COMMANDER,
]

export const FORMAT_BY_ID: Record<string, MtgFormat> = Object.fromEntries(
  FORMATS.map((f) => [f.id, f])
)

export const DEFAULT_FORMAT: MtgFormat = COMMANDER
