import type { AgentLogEntry, LastAction } from '../state/deckStore.ts'

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function AgentLog({
  log,
  lastAction,
  webmcp,
}: {
  log: AgentLogEntry[]
  lastAction: LastAction | null
  webmcp: string
}) {
  return (
    <section className="agent-log" aria-label="Agent activity">
      <div className="agent-proposals-head">
        <div className="t-eyebrow">Agent activity</div>
        <span className="agent-pill">{webmcp}</span>
      </div>
      {lastAction && (
        <p className="agent-receipt">
          Last action: <strong>{lastAction.tool}</strong> · {formatTime(lastAction.at)} · {lastAction.status}
        </p>
      )}
      {log.length === 0 ? (
        <p className="agent-muted">No tool calls yet. Analyze from the button or via WebMCP.</p>
      ) : (
        <ol>
          {log.slice().reverse().map((entry) => (
            <li key={entry.id}>
              <code>{entry.tool}</code>
              <span className={`agent-status ${entry.status}`}>{entry.status}</span>
              <time dateTime={entry.at}>{formatTime(entry.at)}</time>
              {entry.detail ? <small>{entry.detail}</small> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
