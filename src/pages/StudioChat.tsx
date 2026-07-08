import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import {
  useStudioStore,
  type Attachment,
  type ChatMessageRow,
  type ChatSessionRow,
} from '../stores/studioStore'
import { parseAttachments } from '../lib/attachments'
import {
  conversationToHtml,
  conversationToMarkdown,
  messageToHtml,
  messageToMarkdown,
  saveExport,
} from '../lib/exportChat'
import Composer from '../components/Composer'
import ModelPicker from '../components/ModelPicker'
import { Mascot } from '../components/ui'

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

// Stable plugin references — defined at module scope so the renderer is never
// rebuilt per streamed token. `throwOnError: false` makes half-typed formulas
// during streaming render as plain text instead of crashing the pipeline.
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [
  rehypeHighlight,
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
] as never

/** Open a URL in the system default browser (never inside the webview). */
async function openExternal(href: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url: href })
  } catch (e) {
    console.warn('[StudioChat] openExternal failed:', e)
  }
}

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
    <div className="my-3 rounded-lg overflow-hidden border border-line bg-[#0d1117]">
      <div className="flex items-center justify-between px-3 py-1 bg-surface/80 border-b border-line">
        <span className="text-[11px] text-ink-dim font-mono lowercase">{lang}</span>
        <button
          onClick={copy}
          className="text-[11px] text-ink-muted hover:text-ink transition-colors"
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
        <code className="px-1.5 py-0.5 rounded bg-surface-2 text-[0.85em] font-mono text-sky">
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
    <blockquote className="border-l-2 border-line pl-3 my-2 text-ink-muted">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      title={href ? `在浏览器中打开 ${href}` : undefined}
      onClick={(e) => {
        if (href) {
          e.preventDefault()
          void openExternal(href)
        }
      }}
      className="text-sky hover:text-sky underline underline-offset-2 cursor-pointer"
    >
      {children}
      <span aria-hidden="true" className="ml-0.5 text-[0.72em] opacity-70 align-super">
        ↗
      </span>
    </a>
  ),
  hr: () => <hr className="my-4 border-line" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-3 py-1.5 bg-surface text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-line px-3 py-1.5">{children}</td>
  ),
}

const MarkdownMessage = React.memo(function MarkdownMessage({
  text,
}: {
  text: string
}) {
  return (
    <div className="text-[15px] text-ink break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
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
            className="max-h-40 rounded-lg border border-line object-cover"
          />
        ) : (
          <span
            key={i}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 border border-line text-xs text-ink-muted"
          >
            <span aria-hidden="true">📄</span>
            {a.name ?? '文本文件'}
          </span>
        ),
      )}
    </div>
  )
}

// ── Export dropdown ───────────────────────────────────────────────────────────

function ExportMenu({
  label,
  title,
  onMd,
  onHtml,
  buttonClass,
  align = 'left',
}: {
  label: React.ReactNode
  title?: string
  onMd: () => void
  onHtml: () => void
  buttonClass?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={buttonClass ?? 'text-xs hover:text-ink-muted transition-colors'}
      >
        {label}
      </button>
      {open && (
        <div
          className={[
            'absolute z-30 mt-1 w-44 py-1 rounded-lg bg-surface-2 border border-line shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          <button
            onClick={() => {
              setOpen(false)
              onMd()
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
          >
            导出为 Markdown (.md)
          </button>
          <button
            onClick={() => {
              setOpen(false)
              onHtml()
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
          >
            导出为 HTML (.html)
          </button>
        </div>
      )}
    </div>
  )
}

// ── Message item (memoized) ───────────────────────────────────────────────────

const MessageItem = React.memo(function MessageItem({
  msg,
  isLastAssistant,
  streaming,
  sessionTitle,
  onRegenerate,
  showToast,
}: {
  msg: ChatMessageRow
  isLastAssistant: boolean
  streaming: boolean
  sessionTitle: string
  onRegenerate: () => void
  showToast: (msg: string) => void
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

  const exportOne = async (fmt: 'md' | 'html') => {
    try {
      const base = `${sessionTitle}-单条`
      const content =
        fmt === 'md'
          ? messageToMarkdown(msg)
          : messageToHtml(msg, sessionTitle)
      const ok = await saveExport(base, fmt, content)
      if (ok) showToast('已导出该消息')
    } catch (e) {
      showToast(`导出失败：${String(e)}`)
    }
  }

  if (msg.role === 'user') {
    const atts = parseAttachments(msg.attachments_json)
    return (
      <div className="flex flex-col items-end">
        <AttachmentPreview atts={atts} />
        {msg.content && (
          <div className="max-w-[85%] px-4 py-2.5 rounded-pop rounded-br-md bg-grad-primary shadow-glow-primary text-white text-[15px] leading-7 whitespace-pre-wrap break-words">
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
          <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-2.5 text-red-600 text-sm break-words">
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
        <div className="flex items-center gap-3 mt-1.5 text-ink-dim opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={copyMessage}
            className="text-xs hover:text-ink-muted transition-colors"
          >
            {copied ? '已复制' : '复制'}
          </button>
          <ExportMenu
            label="导出"
            title="导出本条消息"
            onMd={() => void exportOne('md')}
            onHtml={() => void exportOne('html')}
          />
          {isLastAssistant && (
            <button
              onClick={onRegenerate}
              className="text-xs hover:text-ink-muted transition-colors"
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
    <div className="flex flex-col w-60 flex-shrink-0 border-r border-line h-full bg-surface/40">
      <div className="px-3 py-2.5 flex-shrink-0">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-2 hover:bg-elevated text-ink border border-line text-sm font-medium transition-colors"
        >
          <span className="text-base leading-none">+</span> 新对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sessions.length === 0 && (
          <p className="text-ink-dim text-xs text-center mt-6 select-none">
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
                className="w-full bg-surface-2 border border-lavender rounded-lg px-2.5 py-2 text-sm text-ink focus:outline-none"
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
                isActive ? 'bg-surface-2' : 'hover:bg-surface-2/60',
              ].join(' ')}
            >
              <div className="flex-1 min-w-0">
                <p
                  className="text-sm text-ink truncate leading-snug"
                  title={s.title || '新对话'}
                >
                  {s.title || '新对话'}
                </p>
                <p className="text-[10px] text-ink-dim mt-0.5">
                  {relativeTime(s.updated_at)}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuId(menuId === s.id ? null : s.id)
                }}
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ink-dim hover:text-ink hover:bg-elevated opacity-0 group-hover:opacity-100 transition-opacity"
                title="更多"
              >
                ⋯
              </button>

              {menuId === s.id && (
                <div className="absolute right-1 top-9 z-20 w-28 py-1 rounded-lg bg-surface-2 border border-line shadow-xl">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      startEdit(s)
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
                  >
                    重命名
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuId(null)
                      setConfirmDelete(s)
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-elevated transition-colors"
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
          <div className="bg-surface border border-line rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-ink mb-1 font-medium">删除该对话？</p>
            <p className="text-xs text-ink-muted mb-4 truncate">
              {confirmDelete.title || '新对话'}
            </p>
            <p className="text-xs text-ink-dim mb-4">
              此操作会永久删除该对话及其全部消息，无法撤销。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted border border-line transition-colors"
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
      <Mascot mood="happy" size={92} className="mb-4" />
      <h1 className="text-2xl font-bold text-gradient mb-1">有什么可以帮你的？</h1>
      <p className="text-sm text-ink-dim mb-8">直接输入问题，或从下面的示例开始</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-3xl">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="text-left px-4 py-3 rounded-card glass hover:-translate-y-0.5 hover:border-line-strong text-sm text-ink-muted leading-relaxed transition-all duration-150"
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
    aggModels,
    currentModel,
    currentProviderId,
    streaming,
    loadError,
    loadModels,
    loadSessions,
    selectSession,
    newSession,
    renameSession,
    deleteSession,
    setModelSel,
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

  const exportConversation = async (fmt: 'md' | 'html') => {
    const title = sessions.find((s) => s.id === activeSessionId)?.title || '新对话'
    try {
      const content =
        fmt === 'md'
          ? conversationToMarkdown(messages, title)
          : conversationToHtml(messages, title)
      const ok = await saveExport(title, fmt, content)
      if (ok) showToast('已导出对话')
    } catch (e) {
      showToast(`导出失败：${String(e)}`)
    }
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
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
        <p className="text-ink-dim text-xs">
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
        <div className="px-4 py-2 border-b border-line flex-shrink-0 flex items-center gap-2 min-h-[48px]">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors"
            title={sidebarOpen ? '收起会话栏' : '展开会话栏'}
          >
            ☰
          </button>

          <span
            className="text-sm text-ink-muted font-medium truncate max-w-[40%]"
            title={activeSession?.title}
          >
            {activeSession?.title || '新对话'}
          </span>

          {hasMessages && (
            <ExportMenu
              label="导出对话"
              title="导出整段对话"
              align="left"
              onMd={() => void exportConversation('md')}
              onHtml={() => void exportConversation('html')}
              buttonClass="flex-shrink-0 text-xs text-ink-muted hover:text-ink border border-line rounded-lg px-2.5 py-1.5 transition-colors"
            />
          )}

          <div className="flex-1" />

          {/* Model selector (grouped by provider) */}
          <ModelPicker
            models={aggModels}
            value={{ providerId: currentProviderId ?? '', modelId: currentModel }}
            onChange={(v) => setModelSel(v.providerId, v.modelId)}
            className="flex-shrink-0 bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors max-w-[220px]"
            title="选择模型"
          />
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
                      sessionTitle={activeSession?.title || '新对话'}
                      onRegenerate={() => void regenerate()}
                      showToast={showToast}
                    />
                  ))}
                </div>
              </div>

              {/* Scroll-to-bottom button */}
              {!autoScroll && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-surface-2 border border-line text-ink-muted hover:bg-elevated shadow-lg transition-colors"
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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-surface-2 border border-line text-sm text-ink shadow-xl">
          {toast ?? loadError}
        </div>
      )}
    </div>
  )
}
