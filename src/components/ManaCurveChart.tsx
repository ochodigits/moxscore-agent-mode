interface ManaCurveChartProps {
  curve: Record<string, number>
  accent?: string
}

export function ManaCurveChart({ curve, accent = 'var(--accent)' }: ManaCurveChartProps) {
  const keys = ['0', '1', '2', '3', '4', '5', '6', '7+']
  const data = keys.map((k) => ({ k, n: curve[k] || 0 }))
  const max = Math.max(1, ...data.map((d) => d.n))

  return (
    <div className="mox-curvechart">
      {data.map((d) => (
        <div key={d.k} className="mox-curvecol">
          <span className="mox-curveval">{d.n || ''}</span>
          <div className="mox-curvebar-track">
            <div className="mox-curvebar" style={{ height: `${(d.n / max) * 100}%`, background: accent }} />
          </div>
          <span className="mox-curvelabel">{d.k}</span>
        </div>
      ))}
    </div>
  )
}
