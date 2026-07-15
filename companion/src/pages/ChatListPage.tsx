import { useNavigate } from 'react-router-dom'
import { useSyncStore, ChatSession } from '../stores/syncStore'

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function SessionItem({ session }: { session: ChatSession }) {
  const navigate = useNavigate()

  return (
    <button
      onClick={() => navigate(`/chat/${session.id}`)}
      className="w-full text-left bg-editor rounded-xl border border-line p-4 flex items-start gap-3 active:bg-surface-2 transition-colors"
    >
      {/* Avatar */}
      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#202123" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-ink truncate">{session.title || '无标题对话'}</p>
          <span className="text-xs text-ink-faint shrink-0">{relativeTime(session.last_message_at)}</span>
        </div>
        {session.model && (
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-2 text-ink-muted mt-1">
            {session.model}
          </span>
        )}
        {session.last_message && (
          <p className="text-xs text-ink-muted mt-1 line-clamp-2">{session.last_message}</p>
        )}
      </div>
    </button>
  )
}

export default function ChatListPage() {
  const chatSessions = useSyncStore((s) => s.chatSessions)

  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-ink">对话</h1>
        <span className="text-sm text-ink-muted">{chatSessions.length} 个会话</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-3">
        {chatSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-sm">暂无对话</p>
          </div>
        ) : (
          chatSessions.map((s) => <SessionItem key={s.id} session={s} />)
        )}
      </div>
    </div>
  )
}
