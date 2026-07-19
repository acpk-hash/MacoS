import { Link } from 'react-router-dom'
import { useSyncStore } from '../stores/syncStore'

const wsLabels: Record<string, { text: string; dot: string }> = {
  connected: { text: '已连接', dot: 'bg-mint' },
  connecting: { text: '连接中', dot: 'bg-gold' },
  reconnecting: { text: '重连中', dot: 'bg-gold' },
  disconnected: { text: '未连接', dot: 'bg-coral' },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const navCards = [
  {
    emoji: '\u{1F4F1}',
    title: '远程控制',
    to: '/remote',
    desc: '从手机管理 Windows 桌面端任务与对话',
    accent: 'bg-primary/10 text-primary',
  },
  {
    emoji: '\u{1F4CA}',
    title: '用量统计',
    to: '/usage',
    desc: '查看 Token 消耗与模型调用统计',
    accent: 'bg-sky/10 text-sky',
  },
  {
    emoji: '\u{1F4C8}',
    title: '热点推送',
    to: '/trends',
    desc: 'TrendRadar 热榜 / RSS / 关键词监控',
    accent: 'bg-gold/10 text-gold',
  },
  {
    emoji: '\u{1F4E1}',
    title: 'Webhook',
    to: '/webhooks',
    desc: '事件推送与外部集成',
    accent: 'bg-mint/10 text-mint',
  },
]

const eventTypeColors: Record<string, string> = {
  assistant_message: 'text-mint',
  command_run: 'text-sky',
  file_edit: 'text-gold',
  turn_completed: 'text-ink-dim',
  error: 'text-coral',
}

export default function Data() {
  const wsState = useSyncStore((s) => s.wsState)
  const chatSessions = useSyncStore((s) => s.chatSessions)
  const tasks = useSyncStore((s) => s.tasks)
  const events = useSyncStore((s) => s.events)

  const ws = wsLabels[wsState] ?? wsLabels.disconnected
  const recentEvents = events.slice(0, 3)

  return (
    <div className="page">
      <div className="page-header">
        <h1>数据</h1>
        <p>使用分析与事件监控</p>
      </div>

      <div className="page-body">
        {/* Quick stats row */}
        <div className="flex gap-2.5 mb-4 animate-in">
          <div className="card-flat flex-1 flex flex-col items-center gap-1 py-3">
            <span className="text-lg font-bold text-ink">{chatSessions.length}</span>
            <span className="text-[11px] text-ink-dim font-medium">对话数</span>
          </div>
          <div className="card-flat flex-1 flex flex-col items-center gap-1 py-3">
            <span className="text-lg font-bold text-ink">{tasks.length}</span>
            <span className="text-[11px] text-ink-dim font-medium">任务数</span>
          </div>
          <div className="card-flat flex-1 flex flex-col items-center gap-1 py-3">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${ws.dot}`} />
              <span className="text-sm font-semibold text-ink">{ws.text}</span>
            </div>
            <span className="text-[11px] text-ink-dim font-medium">同步状态</span>
          </div>
        </div>

        {/* Navigation cards */}
        <div className="flex flex-col gap-3 mb-5">
          {navCards.map((card) => (
            <Link
              key={card.to}
              to={card.to}
              className="card flex items-center gap-4 active:bg-surface-2 transition-all animate-in"
              style={{ textDecoration: 'none' }}
            >
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center text-xl shrink-0 ${card.accent}`}
              >
                {card.emoji}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink">{card.title}</p>
                <p className="text-xs text-ink-muted mt-0.5 leading-snug">{card.desc}</p>
              </div>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="text-ink-faint shrink-0"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>
          ))}
        </div>

        {/* Recent events preview */}
        {recentEvents.length > 0 && (
          <div className="animate-in">
            <div className="flex items-center justify-between mb-2 px-1">
              <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">
                近期事件
              </p>
              <Link to="/remote" className="text-xs text-sky font-medium" style={{ textDecoration: 'none' }}>
                查看全部
              </Link>
            </div>
            <div className="card flex flex-col divide-y divide-line-soft">
              {recentEvents.map((ev) => {
                const color = eventTypeColors[ev.type] ?? 'text-ink-dim'
                const label = ev.summary ?? ev.cmd ?? ev.path ?? ev.type
                return (
                  <div key={ev.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-surface-2 shrink-0 ${color}`}
                    >
                      {ev.type.replace(/_/g, ' ').slice(0, 8).toUpperCase()}
                    </span>
                    <span className="text-xs text-ink-muted truncate flex-1">{label}</span>
                    <span className="text-[10px] text-ink-faint font-mono shrink-0">
                      {formatTime(ev.timestamp)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Empty state for events */}
        {recentEvents.length === 0 && (
          <div className="card-flat flex flex-col items-center py-8 text-ink-faint animate-in">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="opacity-40 mb-2"
            >
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <p className="text-xs">暂无事件数据</p>
          </div>
        )}
      </div>
    </div>
  )
}
