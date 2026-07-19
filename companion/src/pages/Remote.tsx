import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSyncStore, Task, AgentEvent, ChatSession, ChatMessage } from '../stores/syncStore'
import { useAuthStore } from '../stores/authStore'

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  todo:       { text: '待执行',  cls: 'bg-surface-2 text-ink-dim' },
  dispatched: { text: '执行中',  cls: 'bg-sky/20 text-sky' },
  done:       { text: '已完成',  cls: 'bg-mint/20 text-mint' },
  error:      { text: '出错',    cls: 'bg-coral/20 text-coral' },
}

const WS_LABELS: Record<string, { text: string; dot: string }> = {
  connected:    { text: '已连接', dot: 'bg-mint' },
  connecting:   { text: '连接中', dot: 'bg-gold animate-pulse' },
  reconnecting: { text: '重连中', dot: 'bg-gold animate-pulse' },
  disconnected: { text: '未连接', dot: 'bg-coral' },
}

const EVENT_ICON: Record<string, { icon: string; cls: string }> = {
  assistant_message: { icon: '💬', cls: 'text-mint' },
  command_run:       { icon: '⚡', cls: 'text-sky' },
  file_edit:         { icon: '📝', cls: 'text-gold' },
  turn_completed:    { icon: '✅', cls: 'text-mint' },
  error:             { icon: '❌', cls: 'text-coral' },
}

type Tab = 'tasks' | 'events' | 'chat'

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Task List                                                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */

function TaskPanel() {
  const tasks = useSyncStore(s => s.tasks)
  const wsState = useSyncStore(s => s.wsState)
  const createTask = useSyncStore(s => s.createTask)
  const dispatchTask = useSyncStore(s => s.dispatchTask)
  const acceptTask = useSyncStore(s => s.acceptTask)
  const [newTitle, setNewTitle] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const disabled = wsState !== 'connected'

  const handleCreate = () => {
    const t = newTitle.trim()
    if (!t) return
    createTask(t)
    setNewTitle('')
    setShowCreate(false)
  }

  const sorted = [...tasks].sort((a, b) => {
    const order = { dispatched: 0, todo: 1, error: 2, done: 3 }
    const oa = order[a.status] ?? 9
    const ob = order[b.status] ?? 9
    if (oa !== ob) return oa - ob
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  return (
    <div className="flex flex-col gap-3 animate-in">
      {/* Create task bar */}
      {showCreate ? (
        <div className="card flex gap-2 items-center">
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm text-ink outline-none placeholder-ink-faint"
            placeholder="输入任务描述…"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
          />
          <button
            className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium disabled:opacity-40"
            disabled={disabled || !newTitle.trim()}
            onClick={handleCreate}
          >
            发送
          </button>
          <button
            className="px-2 py-1.5 text-xs text-ink-dim"
            onClick={() => setShowCreate(false)}
          >
            取消
          </button>
        </div>
      ) : (
        <button
          className="card flex items-center justify-center gap-2 py-3 text-sm text-primary font-medium active:bg-surface-2 transition-colors disabled:opacity-40"
          disabled={disabled}
          onClick={() => setShowCreate(true)}
        >
          <span className="text-lg">+</span> 新建远程任务
        </button>
      )}

      {disabled && (
        <p className="text-xs text-coral text-center">未连接到桌面端，请确保 Windows 端已登录并开启同步</p>
      )}

      {/* Task list */}
      {sorted.length === 0 ? (
        <div className="card-flat flex flex-col items-center py-10 text-ink-faint">
          <span className="text-3xl mb-2">📋</span>
          <p className="text-xs">桌面端暂无任务</p>
          <p className="text-[10px] mt-1">在上方创建任务，或在桌面端编码窗口中开始工作</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map(task => {
            const st = STATUS_LABEL[task.status] ?? STATUS_LABEL.todo
            return (
              <div key={task.id} className="card">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink font-medium leading-snug">{task.title}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>
                        {st.text}
                      </span>
                      <span className="text-[10px] text-ink-faint">{relativeTime(task.updated_at ?? task.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {task.status === 'todo' && (
                      <button
                        className="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-medium disabled:opacity-40"
                        disabled={disabled}
                        onClick={() => dispatchTask(task.id)}
                      >
                        执行
                      </button>
                    )}
                    {task.status === 'done' && (
                      <button
                        className="px-2.5 py-1 rounded-lg bg-mint/20 text-mint text-[11px] font-medium disabled:opacity-40"
                        disabled={disabled}
                        onClick={() => acceptTask(task.id)}
                      >
                        接受
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Event Feed                                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

function EventPanel() {
  const events = useSyncStore(s => s.events)
  const clearEvents = useSyncStore(s => s.clearEvents)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll stays at bottom for new events
  useEffect(() => {
    // events are newest-first in the store, but we display reversed (newest at bottom)
    // no need to auto-scroll since newest shows at top
  }, [events.length])

  if (events.length === 0) {
    return (
      <div className="card-flat flex flex-col items-center py-10 text-ink-faint animate-in">
        <span className="text-3xl mb-2">📡</span>
        <p className="text-xs">等待桌面端事件…</p>
        <p className="text-[10px] mt-1">当桌面端 agent 运行时，事件会实时同步到此处</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 animate-in">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-ink-faint font-medium">{events.length} 条事件</span>
        <button
          className="text-[11px] text-coral font-medium"
          onClick={clearEvents}
        >
          清空
        </button>
      </div>

      <div className="flex flex-col gap-1.5 max-h-[65vh] overflow-auto">
        {events.map(ev => {
          const ei = EVENT_ICON[ev.type] ?? { icon: '•', cls: 'text-ink-dim' }
          const label = ev.summary ?? ev.cmd ?? ev.path ?? ev.type
          const detail = ev.type === 'command_run' && ev.exit_code != null
            ? `exit ${ev.exit_code}`
            : ev.type === 'file_edit' && (ev.added != null || ev.removed != null)
              ? `+${ev.added ?? 0} -${ev.removed ?? 0}`
              : null

          return (
            <div key={ev.id} className="card-flat flex items-start gap-2.5 py-2.5 px-3">
              <span className="text-base shrink-0 mt-0.5">{ei.icon}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-xs leading-snug ${ei.cls}`}>
                  {ev.type.replace(/_/g, ' ')}
                </p>
                <p className="text-[11px] text-ink mt-0.5 break-words line-clamp-3">{label}</p>
                {detail && (
                  <span className="text-[10px] text-ink-faint font-mono mt-0.5 inline-block">{detail}</span>
                )}
              </div>
              <span className="text-[10px] text-ink-faint font-mono shrink-0 mt-0.5">
                {fmtTime(ev.timestamp)}
              </span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Chat Panel (view desktop sessions + send messages)                         */
/* ═══════════════════════════════════════════════════════════════════════════ */

function ChatPanel() {
  const chatSessions = useSyncStore(s => s.chatSessions)
  const chatMessages = useSyncStore(s => s.chatMessages)
  const sendChatMessage = useSyncStore(s => s.sendChatMessage)
  const wsState = useSyncStore(s => s.wsState)
  const disabled = wsState !== 'connected'

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const selectedSession = chatSessions.find(s => s.id === selectedId) ?? null
  const sessionMessages = selectedId
    ? chatMessages.filter(m => m.session_id === selectedId).sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
    : []

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sessionMessages.length])

  const handleSend = useCallback(() => {
    if (!selectedId || !input.trim() || disabled) return
    sendChatMessage(selectedId, input.trim())
    setInput('')
  }, [selectedId, input, disabled, sendChatMessage])

  // Session list view
  if (!selectedId) {
    return (
      <div className="flex flex-col gap-2 animate-in">
        {chatSessions.length === 0 ? (
          <div className="card-flat flex flex-col items-center py-10 text-ink-faint">
            <span className="text-3xl mb-2">💬</span>
            <p className="text-xs">桌面端暂无对话</p>
            <p className="text-[10px] mt-1">在桌面端开始对话后，会话列表会同步到此处</p>
          </div>
        ) : (
          chatSessions.map(sess => {
            const lastMsg = chatMessages
              .filter(m => m.session_id === sess.id)
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
            return (
              <button
                key={sess.id}
                className="card flex items-center gap-3 text-left active:bg-surface-2 transition-colors w-full"
                onClick={() => setSelectedId(sess.id)}
              >
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary text-sm shrink-0">
                  💬
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink font-medium truncate">{sess.title || '未命名对话'}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {sess.model && (
                      <span className="text-[10px] text-ink-faint font-mono truncate">{sess.model}</span>
                    )}
                    {lastMsg && (
                      <span className="text-[10px] text-ink-faint truncate">
                        {lastMsg.content.slice(0, 40)}
                      </span>
                    )}
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-faint shrink-0">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )
          })
        )}
      </div>
    )
  }

  // Chat detail view
  return (
    <div className="flex flex-col h-full animate-in" style={{ minHeight: 0 }}>
      {/* Session header */}
      <div className="flex items-center gap-2 mb-3">
        <button
          className="text-sm text-primary font-medium"
          onClick={() => setSelectedId(null)}
        >
          ← 返回
        </button>
        <span className="text-sm text-ink font-medium truncate flex-1">
          {selectedSession?.title ?? '对话'}
        </span>
        {selectedSession?.model && (
          <span className="text-[10px] text-ink-faint font-mono px-1.5 py-0.5 rounded bg-surface-2">
            {selectedSession.model}
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto flex flex-col gap-2 mb-3" style={{ maxHeight: '55vh' }}>
        {sessionMessages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-ink-faint py-8">
            暂无消息
          </div>
        ) : (
          sessionMessages.map(msg => (
            <div
              key={msg.id}
              className={`rounded-xl px-3 py-2 max-w-[85%] text-[13px] leading-relaxed ${
                msg.role === 'user'
                  ? 'self-end bg-primary text-white'
                  : msg.role === 'system'
                    ? 'self-center bg-surface-2 text-ink-dim text-[11px] text-center'
                    : 'self-start bg-surface-2 text-ink'
              }`}
            >
              {msg.content}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 items-center shrink-0">
        <input
          className="flex-1 bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-ink outline-none placeholder-ink-faint focus:border-primary transition-colors"
          placeholder={disabled ? '未连接' : '发送消息到桌面端…'}
          disabled={disabled}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
        />
        <button
          className="px-4 py-2.5 rounded-xl bg-primary text-white text-sm font-medium disabled:opacity-40 shrink-0"
          disabled={disabled || !input.trim()}
          onClick={handleSend}
        >
          发送
        </button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Main Remote Page                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

export default function Remote() {
  const navigate = useNavigate()
  const wsState = useSyncStore(s => s.wsState)
  const loggedIn = useAuthStore(s => s.loggedIn)
  const tasks = useSyncStore(s => s.tasks)
  const events = useSyncStore(s => s.events)
  const unreadCount = useSyncStore(s => s.unreadCount)
  const [tab, setTab] = useState<Tab>('tasks')

  const ws = WS_LABELS[wsState] ?? WS_LABELS.disconnected
  const runningTasks = tasks.filter(t => t.status === 'dispatched').length

  if (!loggedIn) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>远程控制</h1>
          <p>登录后可远程管理桌面端</p>
        </div>
        <div className="page-body">
          <div className="card-flat flex flex-col items-center py-10 gap-3 animate-in">
            <span className="text-4xl">🔒</span>
            <p className="text-sm text-ink">需要登录才能使用远程控制</p>
            <button
              className="px-5 py-2 rounded-xl bg-primary text-white text-sm font-medium"
              onClick={() => useAuthStore.getState().openPortal()}
            >
              去登录
            </button>
          </div>
        </div>
      </div>
    )
  }

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: 'tasks', label: '任务', badge: runningTasks || undefined },
    { key: 'events', label: '事件', badge: unreadCount || undefined },
    { key: 'chat', label: '对话' },
  ]

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => navigate('/tools')}
          className="btn-secondary"
          style={{ padding: '4px 8px', borderRadius: 8, fontSize: 13 }}
        >
          ←
        </button>
        <div className="flex-1">
          <h1>远程控制</h1>
          <p>从手机管理 Windows 桌面端</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${ws.dot}`} />
          <span className="text-[11px] text-ink-dim font-medium">{ws.text}</span>
        </div>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--border-soft)',
          background: 'var(--editor)',
          flexShrink: 0,
        }}
      >
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); if (t.key === 'events') useSyncStore.getState().clearEvents() }}
            style={{
              flex: 1,
              padding: '10px 0',
              fontSize: 14,
              fontWeight: tab === t.key ? 600 : 500,
              color: tab === t.key ? 'var(--primary)' : 'var(--text-dim)',
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid var(--primary)' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.15s',
              position: 'relative',
            }}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 4,
                  right: '25%',
                  minWidth: 16,
                  height: 16,
                  borderRadius: 8,
                  background: 'var(--coral, #f44)',
                  color: 'white',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 4px',
                }}
              >
                {t.badge > 99 ? '99+' : t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="page-body">
        {tab === 'tasks' && <TaskPanel />}
        {tab === 'events' && <EventPanel />}
        {tab === 'chat' && <ChatPanel />}
      </div>
    </div>
  )
}
