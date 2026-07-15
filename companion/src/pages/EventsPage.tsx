import { useSyncStore, AgentEvent } from '../stores/syncStore'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface EventConfig {
  color: string
  bg: string
  label: string
}

const EVENT_CONFIGS: Record<string, EventConfig> = {
  assistant_message: { color: 'text-mint', bg: 'bg-mint/10', label: 'AI' },
  command_run: { color: 'text-sky', bg: 'bg-sky/10', label: 'CMD' },
  file_edit: { color: 'text-gold', bg: 'bg-gold/10', label: 'FILE' },
  turn_completed: { color: 'text-ink-muted', bg: 'bg-surface-2', label: 'TURN' },
  error: { color: 'text-coral', bg: 'bg-coral/10', label: 'ERR' },
}

function getConfig(type: string): EventConfig {
  return EVENT_CONFIGS[type] ?? { color: 'text-ink-dim', bg: 'bg-surface-2', label: type.slice(0, 4).toUpperCase() }
}

function EventCard({ event }: { event: AgentEvent }) {
  const cfg = getConfig(event.type)

  return (
    <div className="bg-editor rounded-xl border border-line p-3.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.color}`}>
          {cfg.label}
        </span>
        <span className="text-[10px] text-ink-faint font-mono">{formatTime(event.timestamp)}</span>
      </div>

      {/* Content varies by type */}
      {event.type === 'assistant_message' && event.summary && (
        <p className="text-sm text-ink leading-snug">{event.summary}</p>
      )}

      {event.type === 'command_run' && (
        <div className="flex flex-col gap-1">
          {event.cmd && (
            <code className="text-xs text-sky bg-sky/5 rounded px-2 py-1 font-mono break-all">
              {event.cmd}
            </code>
          )}
          {event.exit_code !== undefined && (
            <span className={`self-start text-[10px] font-mono px-1.5 py-0.5 rounded ${event.exit_code === 0 ? 'bg-mint/10 text-mint' : 'bg-coral/10 text-coral'}`}>
              exit {event.exit_code}
            </span>
          )}
        </div>
      )}

      {event.type === 'file_edit' && (
        <div className="flex flex-col gap-1">
          {event.path && (
            <code className="text-xs text-gold bg-gold/5 rounded px-2 py-1 font-mono break-all">
              {event.path}
            </code>
          )}
          {(event.added !== undefined || event.removed !== undefined) && (
            <div className="flex gap-2 text-[11px] font-mono">
              {event.added !== undefined && (
                <span className="text-mint">+{event.added}</span>
              )}
              {event.removed !== undefined && (
                <span className="text-coral">-{event.removed}</span>
              )}
            </div>
          )}
        </div>
      )}

      {event.type === 'turn_completed' && (
        <p className="text-xs text-ink-muted">{event.summary ?? 'Turn completed'}</p>
      )}

      {event.type === 'error' && event.summary && (
        <p className="text-sm text-coral leading-snug">{event.summary}</p>
      )}

      {/* Fallback for unknown types */}
      {!['assistant_message', 'command_run', 'file_edit', 'turn_completed', 'error'].includes(event.type) &&
        event.summary && (
          <p className="text-sm text-ink-muted">{event.summary}</p>
        )}
    </div>
  )
}

export default function EventsPage() {
  const events = useSyncStore((s) => s.events)
  const clearEvents = useSyncStore((s) => s.clearEvents)

  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-ink">事件</h1>
          <span className="text-xs text-ink-faint bg-surface-2 px-2 py-0.5 rounded-full font-mono">
            {events.length}
          </span>
        </div>
        {events.length > 0 && (
          <button
            onClick={clearEvents}
            className="text-xs text-ink-muted px-3 py-1.5 rounded-lg bg-surface-2 active:bg-line transition-colors"
          >
            清除
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-2.5">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <p className="text-sm">暂无事件</p>
            <p className="text-xs mt-1">Agent 运行时事件将在此实时显示</p>
          </div>
        ) : (
          events.map((ev) => <EventCard key={ev.id} event={ev} />)
        )}
      </div>
    </div>
  )
}
