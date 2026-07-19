import { useState, useRef, useEffect, useCallback } from 'react'
import { useSyncStore, ChatSession, ChatMessage } from '../stores/syncStore'
import {
  chatStream,
  getActiveProvider,
  MobileProvider,
} from '../lib/api'

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function uid(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/* ── Types ────────────────────────────────────────────────────────────────── */

interface LocalMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface LocalSession {
  id: string
  title: string
  messages: LocalMessage[]
  updatedAt: number
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Chat — main AI chat page                                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */

export default function Chat() {
  /* ── Sync store sessions (read-only, shown alongside local) ──────────── */
  const syncSessions = useSyncStore((s) => s.chatSessions)

  /* ── Local state ─────────────────────────────────────────────────────── */
  const [localSessions, setLocalSessions] = useState<LocalSession[]>(() => {
    try {
      const raw = localStorage.getItem('iris.local_chat_sessions')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /* persist local sessions */
  useEffect(() => {
    localStorage.setItem('iris.local_chat_sessions', JSON.stringify(localSessions))
  }, [localSessions])

  /* scroll to bottom on message change */
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }, [])

  /* ── Derived ─────────────────────────────────────────────────────────── */
  const activeLocal = localSessions.find((s) => s.id === activeSessionId) ?? null
  const isInChat = activeSessionId !== null

  /* ── Handlers ────────────────────────────────────────────────────────── */

  function createSession() {
    const provider = getActiveProvider()
    if (!provider) return
    const sess: LocalSession = {
      id: uid(),
      title: '新对话',
      messages: [],
      updatedAt: Date.now(),
    }
    setLocalSessions((prev) => [sess, ...prev])
    setActiveSessionId(sess.id)
  }

  function deleteSession(id: string) {
    setLocalSessions((prev) => prev.filter((s) => s.id !== id))
    if (activeSessionId === id) setActiveSessionId(null)
  }

  async function sendMessage() {
    const text = input.trim()
    if (!text || streaming || !activeLocal) return

    const provider = getActiveProvider()
    if (!provider) return

    const userMsg: LocalMessage = { id: uid(), role: 'user', content: text }
    const assistantMsg: LocalMessage = { id: uid(), role: 'assistant', content: '' }

    /* update session with user message */
    setLocalSessions((prev) =>
      prev.map((s) =>
        s.id === activeLocal.id
          ? {
              ...s,
              messages: [...s.messages, userMsg],
              title: s.messages.length === 0 ? text.slice(0, 30) : s.title,
              updatedAt: Date.now(),
            }
          : s,
      ),
    )
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    /* prepare for streaming */
    setStreaming(true)
    setStreamingContent('')
    scrollToBottom()

    const abort = new AbortController()
    abortRef.current = abort

    const history = [
      ...activeLocal.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: text },
    ]

    let accumulated = ''
    const sessionId = activeLocal.id

    await chatStream({
      messages: history,
      model: provider.model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      signal: abort.signal,
      onToken(t) {
        accumulated += t
        setStreamingContent(accumulated)
        scrollToBottom()
      },
      onDone() {
        assistantMsg.content = accumulated
        /* user message was already appended above; only add assistant reply */
        setLocalSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now() }
              : s,
          ),
        )
        setStreaming(false)
        setStreamingContent('')
        scrollToBottom()
      },
      onError(e) {
        assistantMsg.content = `[错误] ${e}`
        setLocalSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now() }
              : s,
          ),
        )
        setStreaming(false)
        setStreamingContent('')
      },
    })
  }

  function stopStreaming() {
    abortRef.current?.abort()
    setStreaming(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  const provider = getActiveProvider()

  /* ═══════════════════════════════════════════════════════════════════════ */
  /*  Render: session list                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */

  if (!isInChat) {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-ink">对话</h1>
            <p className="text-xs text-ink-dim mt-0.5">
              {localSessions.length + syncSessions.length} 个会话
            </p>
          </div>
        </header>

        {/* No provider warning */}
        {!provider && (
          <div className="mx-4 mt-4 rounded-[14px] bg-awaiting/8 border border-awaiting/15 px-4 py-3.5 flex items-start gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-awaiting shrink-0 mt-0.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div>
              <p className="text-sm font-medium text-ink">未配置 AI 服务商</p>
              <p className="text-xs text-ink-muted mt-0.5">请先在设置中配置 AI 服务商后开始对话</p>
            </div>
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-2.5">
          {/* Local sessions */}
          {localSessions.map((sess) => (
            <SessionCard
              key={sess.id}
              title={sess.title}
              subtitle={sess.messages[sess.messages.length - 1]?.content}
              time={relativeTime(new Date(sess.updatedAt).toISOString())}
              msgCount={sess.messages.length}
              onClick={() => setActiveSessionId(sess.id)}
              onDelete={() => deleteSession(sess.id)}
            />
          ))}

          {/* Sync sessions */}
          {syncSessions.map((sess: ChatSession) => (
            <SessionCard
              key={sess.id}
              title={sess.title || '无标题对话'}
              subtitle={sess.last_message}
              time={relativeTime(sess.last_message_at)}
              model={sess.model}
              synced
              onClick={() => {}}
            />
          ))}

          {localSessions.length === 0 && syncSessions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-ink-faint">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mb-4 opacity-30">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <p className="text-sm font-medium">暂无对话</p>
              <p className="text-xs mt-1">点击下方按钮开始新对话</p>
            </div>
          )}
        </div>

        {/* FAB */}
        {provider && (
          <button
            onClick={createSession}
            className="fixed bottom-24 right-5 w-14 h-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center active:scale-95 transition-transform z-20"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="sr-only">新对话</span>
          </button>
        )}
      </div>
    )
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /*  Render: chat messages view                                            */
  /* ═══════════════════════════════════════════════════════════════════════ */

  const messages = activeLocal?.messages ?? []

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-3 py-3 flex items-center gap-2">
        <button
          onClick={() => setActiveSessionId(null)}
          className="w-9 h-9 -ml-1 flex items-center justify-center rounded-[10px] active:bg-surface-2 transition-colors"
          aria-label="返回"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink truncate">
            {activeLocal?.title || '对话'}
          </p>
          {provider && (
            <p className="text-[11px] text-ink-faint truncate">{provider.model}</p>
          )}
        </div>
        {streaming && (
          <button
            onClick={stopStreaming}
            className="px-3 py-1.5 rounded-[8px] bg-failed/10 text-failed text-xs font-medium active:bg-failed/20 transition-colors"
          >
            停止
          </button>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center py-20 text-ink-faint animate-in">
            <div className="w-16 h-16 rounded-full bg-surface-2 flex items-center justify-center mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm">发送消息开始对话</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={
              msg.role === 'user'
                ? 'chat-bubble user self-end max-w-[85%]'
                : 'chat-bubble assistant self-start max-w-[85%]'
            }
          >
            <div className="text-sm whitespace-pre-wrap leading-relaxed break-words">
              {msg.content}
            </div>
          </div>
        ))}

        {/* Streaming bubble */}
        {streaming && streamingContent && (
          <div className="chat-bubble assistant self-start max-w-[85%] animate-in">
            <div className="text-sm whitespace-pre-wrap leading-relaxed break-words">
              {streamingContent}
              <span className="inline-block w-1.5 h-4 bg-primary/60 ml-0.5 animate-pulse rounded-sm align-middle" />
            </div>
          </div>
        )}

        {/* Streaming indicator (no content yet) */}
        {streaming && !streamingContent && (
          <div className="chat-bubble assistant self-start animate-in">
            <div className="flex items-center gap-1.5 py-1">
              <span className="w-2 h-2 rounded-full bg-ink-dim animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-ink-dim animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-ink-dim animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div
        className="bg-bg border-t border-line px-3 py-3 flex items-end gap-2"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          disabled={streaming}
          className="flex-1 resize-none bg-editor border border-line rounded-[14px] px-4 py-2.5 text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 transition leading-relaxed disabled:opacity-50"
          style={{ minHeight: '44px', maxHeight: '140px' }}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || streaming}
          className="w-11 h-11 rounded-full bg-primary text-white flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-all"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22l-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/* ── Session card sub-component ───────────────────────────────────────────── */

function SessionCard({
  title,
  subtitle,
  time,
  msgCount,
  model,
  synced,
  onClick,
  onDelete,
}: {
  title: string
  subtitle?: string
  time?: string
  msgCount?: number
  model?: string
  synced?: boolean
  onClick: () => void
  onDelete?: () => void
}) {
  const [showDelete, setShowDelete] = useState(false)

  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        if (onDelete) setShowDelete(true)
      }}
      className="w-full text-left bg-editor rounded-[14px] border border-line p-4 flex items-start gap-3 active:bg-surface-2 transition-colors relative"
    >
      {/* Icon */}
      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
        synced ? 'bg-running/10' : 'bg-primary/8'
      }`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={synced ? 'text-running' : 'text-ink'}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-ink truncate">{title}</p>
          <span className="text-[11px] text-ink-faint shrink-0">{time}</span>
        </div>

        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {model && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-surface-2 text-ink-muted">
              {model}
            </span>
          )}
          {synced && (
            <span className="badge-sky text-[10px] px-1.5 py-0.5 rounded-md">
              已同步
            </span>
          )}
          {typeof msgCount === 'number' && (
            <span className="text-[10px] text-ink-faint">{msgCount} 条消息</span>
          )}
        </div>

        {subtitle && (
          <p className="text-xs text-ink-muted mt-1.5 line-clamp-2 leading-relaxed">{subtitle}</p>
        )}
      </div>

      {/* Delete overlay */}
      {showDelete && onDelete && (
        <div
          className="absolute inset-0 bg-editor/95 rounded-[14px] flex items-center justify-center gap-3 z-10 animate-in"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => setShowDelete(false)}
            className="px-4 py-2 rounded-[10px] bg-surface-2 text-ink-muted text-sm font-medium active:bg-surface transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => { onDelete(); setShowDelete(false); }}
            className="px-4 py-2 rounded-[10px] bg-failed/10 text-failed text-sm font-medium border border-failed/15 active:bg-failed/20 transition-colors"
          >
            删除对话
          </button>
        </div>
      )}
    </button>
  )
}
