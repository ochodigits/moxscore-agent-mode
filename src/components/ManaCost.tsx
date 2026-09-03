const PIP_COLORS: Record<string, { bg: string; fg: string }> = {
  W: { bg: '#EDE6D0', fg: '#3a3320' },
  U: { bg: '#3B7DD8', fg: '#fff' },
  B: { bg: '#4A4554', fg: '#fff' },
  R: { bg: '#DD5640', fg: '#fff' },
  G: { bg: '#3FA45B', fg: '#fff' },
  C: { bg: '#9C93AE', fg: '#fff' },
}

export function ManaCost({ cost, scale = 1 }: { cost: string; scale?: number }) {
  if (!cost) return null
  const tokens = (cost.match(/\{[^}]+\}/g) || []).map((t) => t.slice(1, -1))
  const sz = 17 * scale
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {tokens.map((tok, i) => {
        const c = PIP_COLORS[tok] || { bg: 'rgba(255,255,255,0.16)', fg: 'var(--text-primary)' }
        return (
          <span
            key={i}
            style={{
              width: sz, height: sz, borderRadius: '50%', background: c.bg, color: c.fg,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: sz * 0.62,
              boxShadow: 'inset 0 -1px 1px rgba(0,0,0,0.25)', flexShrink: 0,
            }}
          >
            {tok}
          </span>
        )
      })}
    </span>
  )
}
