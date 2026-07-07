import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import {
  useStudioStore,
  type Attachment,
  type ChatMessageRow,
  type ChatSessionRow,
} from '../stores/studioStore'
import { parseAttachments } from '../lib/attachments'
import Composer from '../components/Composer'

// ── Environment guard ─────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

const EXAMPLE_PROMPTS = [
  '用通俗的语言解释一下量子纠缠',
  '帮我写一封简洁专业的请假邮件',
  '给我三个适合周末做的家常菜，并附上做法',
]

// ── Markdown rendering ────────────────────────────────────────────────────────

/** Recursively extract raw text from a React node (for the copy button). */
function nodeText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (React.isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

function CodeBlock({
  lang,
  className,
  raw,
  children,
}: {
  lang: string
  className?: string
  raw: string
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="my-3 rounded-lg overflow-hidden border border-gray-800 bg-[#0d1117]">
      <div className="flex items-center justify-between px-3 py-1 bg-gray-900/80 border-b border-gray-800">
        <span className="text-[11px] text-gray-500 font-mono lowercase">{lang}</span>
        <button
          onClick={copy}
          className="text-[11px] text-gray-400 hover:text-gray-200 transition-colors"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

const mdComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code(props) {
    const { className, children } = props
    const match = /language-(\w+)/.exec(className || '')
    const raw = nodeText(children)
    const isBlock = !!match || raw.includes('\n')
    if (!isBlock) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-gray-800 text-[0.85em] font-mono text-blue-200">
          {children}
        </code>
      )
    }
    return (
      <CodeBlock lang={match?.[1] ?? 'text'} className={className} raw={raw}>
        {children}
      </CodeBlock>
    )
  },
  p: ({ children }) => <p className="my-2 leading-7">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc pl-6 space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal pl-6 space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-7">{children}</li>,
  h1: ({ children }) => (
    <h1 className="text-xl font-semibold mt-4 mb-2">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold mt-4 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-3 mb-1.5">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-700 pl-3 my-2 text-gray-400">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-gray-800" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-gray-700 px-3 py-1.5 bg-gray-900 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-gray-800 px-3 py-1.5">{children}</td>
  ),
}

const MarkdownMessage = React.memo(function MarkdownMessage({
  text,
}: {
  text: string
}) {
  return (
    <div className="text-[15px] text-gray-200 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

// ── Small presentational bits ─────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-2">
      <span className="w-2 h-2 rounded-full bg-gray-500 animate-pulse" />
      <span
        className="w-2 h-2 rounded-full bg-gray-500 animate-pulse"
        style={{ animationDelay: '0.2s' }}
      />
      <span
        className="w-2 h-2 rounded-full bg-gray-500 animate-pulse"
        style={{ animationDelay: '0.4s' }}
      />
    </div>
  )
}

function BlinkCursor() {
  return (
    <span className="inline-block w-[7px] h-[15px] ml-0.5 -mb-0.5 bg-gray-300 animate-pulse rounded-[1px] align-middle" />
  )
}

function AttachmentPreview({ atts }: { atts: Attachment[] }) {
  if (atts.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 mb-2 justify-end">
      {atts.map((a, i) =>
        a.kind === 'image' && a.data_url ? (
          <img
            key={i}
            src={a.data_url}
            alt={a.name ?? '图片'}
            className="max-h-40 rounded-lg border border-gray-700 object-cover"
          />
        ) : (
          <span
            key={i}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-xs text-gray-300"
          >
            <span aria-hidden="true">📄</span>
            {a.name ?? '文本文件'}
          </span>
        ),
      )}
    </div>
  )
}

// ── Message item (memoized) ───────────────────────────────────────────────────

const MessageItem = React.memo(function MessageItem({
  msg,
  isLastAssistant,
  streaming,
  onRegenerate,
}: {
  msg: ChatMessageRow
  isLastAssistant: boolean
  streaming: boolean
  onRegenerate: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(msg.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  if (msg.role === 'user') {
    const atts = parseAttachments(msg.attachments_json)
    return (
      <div className="flex flex-col items-end">
        <AttachmentPreview atts={atts} />
        {msg.content && (
          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-blue-600 text-white text-[15px] leading-7 whitespace-pre-wrap break-words">
            {msg.content}
          </div>
        )}
      </div>
    )
  }

  // Assistant message: full width, no bubble background (ChatGPT-like).
  const isError = msg.status === 'error'
  return (
    <div className="group flex flex-col items-start w-full">
      <div className="w-full">
        {isError ? (
          <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-2.5 text-red-300 text-sm break-words">
            {msg.content || '请求出错'}
          </div>
        ) : msg.content === '' && streaming ? (
          <TypingDots />
        ) : (
          <div>
            <MarkdownMessage text={msg.content} />
            {msg.status === 'streaming' && <BlinkCursor />}
          </div>
        )}
      </div>

      {/* Action row */}
      {!isError && msg.status !== 'streaming' && msg.content !== '' && (
        <div className="flex items-center gap-3 mt-1.5 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={copyMessage}
            className="text-xs hover:text-gray-300 transition-colors"
          >
            {copied ? '已复制' : '复制'}
          </button>
          {isLastAssistant && (
            <button
              onClick={onRegenerate}
              className="text-xs hover:text-gray-300 transition-colors"
            >
              重新生成
            </button>
          )}
        </div>
      )}
    </div>
  )
})

// ── Session sidebar ───────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h 前`
  return `${Math.floor(h / 24)}d 前`
}

function SessionSidebar({
  open,
  sessions,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  open: boolean
  sessions: ChatSessionRow[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ChatSessionRow | null>(null)

  if (!open) return null

  const startEdit = (s: ChatSessionRow) => {
    setEditingId(s.id)
    setEditText(s.title || '新对话')
    setMenuId(null)
  }
  const commitEdit = () => {
    if (editingId) onRename(editingId, editText)
    setEditingId(null)
  }

  return (
    <div className="flex flex-col w-60 flex-shrink-0 border-r border-gray-800 h-full bg-gray-900/40">
      <div className="px-3 py-2.5 flex-shrink-0">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 text-sm font-medium transition-colors"
        >
          <span className="text-base leading-none">+</span> 新对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sessions.length === 0 && (
          <p className="text-gray-600 text-xs text-center mt-6 select-none">
            暂无对话
          </p>
        )}
        {sessions.map((s) => {
          const isActive = s.id === activeId
          if (editingId === s.id) {
            return (
              <input
                key={s.id}
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitEdit()
                  } else if (e.key === 'Escape') {
                    setEditingId(null)
                  }
                }}
                className="w-full bg-gray-800 border border-blue-600 rounded-lg px-2.5 py-2 text-sm text-gray-100 focus:outline-none"
              />
            )
          }
          return (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              onDoubleClick={() => startEdit(s)}
              className={[
                'group relative flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                isActive ? 'bg-gray-800' : 'hover:bg-gray-800/60',
              ].join(' ')}
            >
              <div className="flex-1 min-w-0">
                <p
                  className="text-sm text-gray-200 truncate leading-snug"
                  title={s.title || '新对话'}
                >
                  {s.title || '新对话'}
                </p>
                <p className="text-[10px] text-gray-600 mt-0.5">
                  {relativeTime(s.updated_at)}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuId(menuId === s.id ? null : s.id)
                }}
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
                title="更多"
              >
                ⋯
              </button>

              {menuId === s.id && (
                <div className="absolute right-1 top-9 z-20 w-28 py-1 rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      startEdit(s)
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                  >
                    重命名
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuId(null)
                      setConfirmDelete(s)
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700 transition-colors"
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-gray-200 mb-1 font-medium">删除该对话？</p>
            <p className="text-xs text-gray-400 mb-4 truncate">
              {confirmDelete.title || '新对话'}
            </p>
            <p className="text-xs text-gray-500 mb-4">
              此操作会永久删除该对话及其全部消息，无法撤销。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDelete(confirmDelete.id)
                  setConfirmDelete(null)
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white border border-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <h1 className="text-2xl font-semibold text-gray-200 mb-1">有什么可以帮你的？</h1>
      <p className="text-sm text-gray-500 mb-8">直接输入问题，或从下面的示例开始</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-3xl">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="text-left px-4 py-3 rounded-xl border border-gray-800 bg-gray-900/50 hover:bg-gray-800 hover:border-gray-700 text-sm text-gray-300 leading-relaxed transition-colors"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StudioChat() {
  const {
    sessions,
    activeSessionId,
    messages,
    models,
    currentModel,
    streaming,
    loadError,
    loadModels,
    loadSessions,
    selectSession,
    newSession,
    renameSession,
    deleteSession,
    setModel,
    send,
    regenerate,
    stop,
  } = useStudioStore()

  const [draft, setDraft] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | null>(null)

  const isStreaming = activeSessionId ? !!streaming[activeSessionId] : false

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  // Initial load.
  useEffect(() => {
    if (!isTauri) return
    loadModels()
    loadSessions()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom on new content (unless the user scrolled up).
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, autoScroll])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAutoScroll(nearBottom)
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAutoScroll(true)
  }

  const handleSend = (content: string, attachments: Attachment[]) => {
    setAutoScroll(true)
    void send(content, attachments)
  }

  // Index of the last assistant message (for the regenerate affordance).
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-gray-400 text-sm">请在桌面应用中使用</p>
        <p className="text-gray-600 text-xs">
          此功能需要 Tauri 桌面运行时，无法在普通浏览器中运行。
        </p>
      </div>
    )
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const hasMessages = messages.length > 0

  const composerPlaceholder = !currentModel
    ? '正在加载模型…'
    : '给 AI 发送消息，Enter 发送 / Shift+Enter 换行'

  return (
    <div className="flex h-full">
      <SessionSidebar
        open={sidebarOpen}
        sessions={sessions}
        activeId={activeSessionId}
        onSelect={(id) => void selectSession(id)}
        onNew={() => {
          newSession()
          setDraft('')
        }}
        onRename={(id, title) => void renameSession(id, title)}
        onDelete={(id) => void deleteSession(id)}
      />

      <div className="flex flex-col flex-1 min-w-0 h-full">
        {/* Top bar */}
        <div className="px-4 py-2 border-b border-gray-800 flex-shrink-0 flex items-center gap-2 min-h-[48px]">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            title={sidebarOpen ? '收起会话栏' : '展开会话栏'}
          >
            ☰
          </button>

          <span
            className="text-sm text-gray-300 font-medium truncate max-w-[40%]"
            title={activeSession?.title}
          >
            {activeSession?.title || '新对话'}
          </span>

          <div className="flex-1" />

          {/* Model selector */}
          <select
            value={currentModel}
            onChange={(e) => setModel(e.target.value)}
            className="flex-shrink-0 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors max-w-[180px]"
            title="选择模型"
          >
            {models.length === 0 && <option value="">加载中…</option>}
            {!models.includes(currentModel) && currentModel && (
              <option value={currentModel}>{currentModel}</option>
            )}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {/* Messages / empty state */}
        {!hasMessages ? (
          <div className="flex-1 flex flex-col min-h-0">
            <EmptyState onPick={(t) => setDraft(t)} />
            <Composer
              draft={draft}
              setDraft={setDraft}
              busy={isStreaming}
              disabled={!currentModel}
              onSend={handleSend}
              onStop={() => void stop()}
              showToast={showToast}
              placeholder={composerPlaceholder}
            />
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-h-0">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="absolute inset-0 overflow-y-auto"
              >
                <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                  {messages.map((msg, idx) => (
                    <MessageItem
                      key={msg.id}
                      msg={msg}
                      isLastAssistant={idx === lastAssistantIdx}
                      streaming={isStreaming}
                      onRegenerate={() => void regenerate()}
                    />
                  ))}
                </div>
              </div>

              {/* Scroll-to-bottom button */}
              {!autoScroll && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 shadow-lg transition-colors"
                  title="回到底部"
                >
                  ↓
                </button>
              )}
            </div>

            <Composer
              draft={draft}
              setDraft={setDraft}
              busy={isStreaming}
              disabled={!currentModel}
              onSend={handleSend}
              onStop={() => void stop()}
              showToast={showToast}
              placeholder={composerPlaceholder}
            />
          </>
        )}
      </div>

      {/* Toast */}
      {(toast || loadError) && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 shadow-xl">
          {toast ?? loadError}
        </div>
      )}
    </div>
  )
}
