import { FORMATS, type MtgFormat } from '../lib/formats'

interface FormatSelectorProps {
  value: MtgFormat
  onChange: (f: MtgFormat) => void
}

const GROUPS = [
  'Digital (MTG Arena)',
  'Constructed',
  'Limited',
  'Multiplayer',
  'Specialty / Casual',
]

export function FormatSelector({ value, onChange }: FormatSelectorProps) {
  const grouped = GROUPS.map((g) => ({
    label: g,
    formats: FORMATS.filter((f) => f.group === g),
  }))

  return (
    <select
      className="mox-format-select"
      value={value.id}
      onChange={(e) => {
        const found = FORMATS.find((f) => f.id === e.target.value)
        if (found) onChange(found)
      }}
      title="Select format"
    >
      {grouped.map(({ label, formats }) => (
        <optgroup key={label} label={label}>
          {formats.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.deckLimit})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
