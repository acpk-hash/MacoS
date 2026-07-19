import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useSyncStore,
  Task,
  AgentEvent,
  FileEntry,
  FileContent,
} from '../stores/syncStore'
import { useAuthStore } from '../stores/authStore'

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function relativeTime(ts: number | string | undefined): string {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const diff = Date.now() - t
  const s = Math.floor(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function shortPath(p: string): string {
  if (!p) return ''
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  todo: { text: '待执行', cls: 'bg-surface-2 text-ink-dim' },
  dispatched: { text: '执行中', cls: 'bg-sky/20 text-sky' },
  done: { text: '已完成', cls: 'bg-mint/20 text-mint' },
  error: { text: '出错', cls: 'bg-coral/20 text-coral' },
}

const WS_LABELS: Record<string, { text: string; dot: string }> = {
  connected: { text: '已连接', dot: 'bg-mint' },
  connecting: { text: '连接中', dot: 'bg-gold animate-pulse' },
  reconnecting: { text: '重连中', dot: 'bg-gold animate-pulse' },
  disconnected: { text: '未连接', dot: 'bg-coral' },
}

const EVENT_ICON: Record<string, { icon: string; cls: string }> = {
  assistant_message: { icon: '💬', cls: 'text-mint' },
  command_run: { icon: '⚡', cls: 'text-sky' },
  file_edit: { icon: '📝', cls: 'text-gold' },
  turn_completed: { icon: '✅', cls: 'text-mint' },
  error: { icon: '❌', cls: 'text-coral' },
  tool_use: { icon: '🔧', cls: 'text-sky' },
  thinking: { icon: '🧠', cls: 'text-primary' },
}

type Tab = 'tasks' | 'events' | 'files' | 'chat'

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Task Panel                                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

function TaskPanel() {
  const tasks = useSyncStore((s) => s.tasks)
  const sessions = useSyncStore((s) => s.sessions)
  const events = useSyncStore((s) => s.events)
  const wsState = useSyncStore((s) => s.wsState)
  const createTask = useSyncStore((s) => s.createTask)
  const dispatchTask = useSyncStore((s) => s.dispatchTask)
  const acceptTask = useSyncStore((s) => s.acceptTask)
  const listFiles = useSyncStore((s) => s.listFiles)
  const [newTitle, setNewTitle] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
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
    return b.created_at - a.created_at
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
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
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
        <p className="text-xs text-coral text-center">
          未连接到桌面端，请确保 Windows 端已登录并开启同步
        </p>
      )}

      {/* Task list */}
      {sorted.length === 0 ? (
        <div className="card-flat flex flex-col items-center py-10 text-ink-faint">
          <span className="text-3xl mb-2">📋</span>
          <p className="text-xs">桌面端暂无任务</p>
          <p className="text-[10px] mt-1">
            在上方创建任务，或在桌面端编码窗口中开始工作
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((task) => {
            const st = STATUS_LABEL[task.status] ?? STATUS_LABEL.todo
            const expanded = expandedId === task.id
            const taskEvents = events.filter((e) => e.task_id === task.id)
            const taskSessions = sessions.filter(
              (s) => s.task_id === task.id
            )

            return (
              <div key={task.id} className="card">
                {/* Task header */}
                <button
                  className="w-full text-left"
                  onClick={() =>
                    setExpandedId(expanded ? null : task.id)
                  }
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink font-medium leading-snug">
                        {task.title}
                      </p>

                      {/* Workdir */}
                      {task.workdir && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[10px]">📁</span>
                          <span className="text-[11px] text-ink-muted font-mono truncate">
                            {shortPath(task.workdir)}
                          </span>
                        </div>
                      )}

                      {/* Stats row */}
                      <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}
                        >
                          {st.text}
                        </span>
                        {task.session_count > 0 && (
                          <span className="text-[10px] text-ink-faint">
                            {task.session_count} 会话
                          </span>
                        )}
                        {task.file_count > 0 && (
                          <span className="text-[10px] text-ink-faint">
                            {task.file_count} 文件
                          </span>
                        )}
                        <span className="text-[10px] text-ink-faint">
                          {relativeTime(task.updated_at || task.created_at)}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 shrink-0 items-end">
                      {task.status === 'todo' && (
                        <button
                          className="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-medium disabled:opacity-40"
                          disabled={disabled}
                          onClick={(e) => {
                            e.stopPropagation()
                            dispatchTask(task.id)
                          }}
                        >
                          执行
                        </button>
                      )}
                      {task.status === 'done' && (
                        <button
                          className="px-2.5 py-1 rounded-lg bg-mint/20 text-mint text-[11px] font-medium disabled:opacity-40"
                          disabled={disabled}
                          onClick={(e) => {
                            e.stopPropagation()
                            acceptTask(task.id)
                          }}
                        >
                          接受
                        </button>
                      )}
                      {task.status === 'dispatched' && (
                        <div className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-sky animate-pulse" />
                          <span className="text-[10px] text-sky font-medium">
                            运行中
                          </span>
                        </div>
                      )}
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={`text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`}
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </div>
                  </div>
                </button>

                {/* Expanded detail */}
                {expanded && (
                  <div className="mt-3 pt-3 border-t border-line-soft">
                    {/* Sessions for this task */}
                    {taskSessions.length > 0 && (
                      <div className="mb-3">
                        <p className="text-[10px] font-bold text-ink-dim uppercase tracking-wide mb-1.5">
                          会话
                        </p>
                        {taskSessions.map((sess) => (
                          <div
                            key={sess.id}
                            className="flex items-center gap-2 py-1"
                          >
                            <span className="text-[10px] font-mono text-ink-faint">
                              {sess.engine}
                            </span>
                            <span className="text-[10px] text-ink-faint">
                              {relativeTime(sess.started_at)}
                            </span>
                            {!sess.ended_at && (
                              <span className="w-1.5 h-1.5 rounded-full bg-sky animate-pulse" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Recent events for this task */}
                    {taskEvents.length > 0 ? (
                      <div>
                        <p className="text-[10px] font-bold text-ink-dim uppercase tracking-wide mb-1.5">
                          执行过程
                        </p>
                        <div className="flex flex-col gap-1 max-h-48 overflow-auto">
                          {taskEvents.slice(0, 20).map((ev) => {
                            const ei = EVENT_ICON[ev.type] ?? {
                              icon: '•',
                              cls: 'text-ink-dim',
                            }
                            const label =
                              ev.summary ??
                              ev.cmd ??
                              ev.path ??
                              ev.message ??
                              ev.type
                            return (
                              <div
                                key={ev.id}
                                className="flex items-start gap-2 py-1"
                              >
                                <span className="text-xs shrink-0">
                                  {ei.icon}
                                </span>
                                <span className="text-[11px] text-ink-muted break-words line-clamp-2 flex-1">
                                  {label}
                                </span>
                                <span className="text-[10px] text-ink-faint font-mono shrink-0">
                                  {fmtTime(ev.timestamp)}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : (
                      <p className="text-[10px] text-ink-faint text-center py-2">
                        暂无执行记录
                      </p>
                    )}

                    {/* Browse files button */}
                    {task.workdir && (
                      <button
                        className="mt-2 w-full py-2 rounded-lg bg-surface-2 text-[11px] text-primary font-medium active:bg-surface-3 transition-colors disabled:opacity-40"
                        disabled={disabled}
                        onClick={() => listFiles(task.workdir)}
                      >
                        📂 浏览工作目录
                      </button>
                    )}
                  </div>
                )}
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
  const events = useSyncStore((s) => s.events)
  const clearEvents = useSyncStore((s) => s.clearEvents)

  if (events.length === 0) {
    return (
      <div className="card-flat flex flex-col items-center py-10 text-ink-faint animate-in">
        <span className="text-3xl mb-2">📡</span>
        <p className="text-xs">等待桌面端事件…</p>
        <p className="text-[10px] mt-1">
          当桌面端 agent 运行时，事件会实时同步到此处
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 animate-in">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-ink-faint font-medium">
          {events.length} 条事件
        </span>
        <button
          className="text-[11px] text-coral font-medium"
          onClick={clearEvents}
        >
          清空
        </button>
      </div>

      <div className="flex flex-col gap-1.5 max-h-[65vh] overflow-auto">
        {events.map((ev) => {
          const ei = EVENT_ICON[ev.type] ?? { icon: '•', cls: 'text-ink-dim' }
          const label =
            ev.summary ?? ev.cmd ?? ev.path ?? ev.message ?? ev.type
          const detail =
            ev.type === 'command_run' && ev.exit_code != null
              ? `exit ${ev.exit_code}`
              : ev.type === 'file_edit' &&
                  (ev.added != null || ev.removed != null)
                ? `+${ev.added ?? 0} -${ev.removed ?? 0}`
                : null

          return (
            <div
              key={ev.id}
              className="card-flat flex items-start gap-2.5 py-2.5 px-3"
            >
              <span className="text-base shrink-0 mt-0.5">{ei.icon}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-xs leading-snug ${ei.cls}`}>
                  {ev.type.replace(/_/g, ' ')}
                </p>
                <p className="text-[11px] text-ink mt-0.5 break-words line-clamp-3">
                  {label}
                </p>
                {detail && (
                  <span className="text-[10px] text-ink-faint font-mono mt-0.5 inline-block">
                    {detail}
                  </span>
                )}
              </div>
              <span className="text-[10px] text-ink-faint font-mono shrink-0 mt-0.5">
                {fmtTime(ev.timestamp)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  File Browser                                                               */
/* ═══════════════════════════════════════════════════════════════════════════ */

function FilePanel() {
  const wsState = useSyncStore((s) => s.wsState)
  const fileRoot = useSyncStore((s) => s.fileRoot)
  const fileEntries = useSyncStore((s) => s.fileEntries)
  const fileContentData = useSyncStore((s) => s.fileContent)
  const fileBrowsing = useSyncStore((s) => s.fileBrowsing)
  const listFilesFn = useSyncStore((s) => s.listFiles)
  const readFileFn = useSyncStore((s) => s.readFile)
  const disabled = wsState !== 'connected'

  const [viewingFile, setViewingFile] = useState<string | null>(null)
  const [pathStack, setPathStack] = useState<string[]>([])

  const navigateToDir = (relPath: string) => {
    const newPath = relPath === '..' ? pathStack.slice(0, -1) : [...pathStack, relPath]
    setPathStack(newPath)
    const fullPath = newPath.length > 0 ? newPath.join('/') : ''
    listFilesFn(fullPath || undefined)
    setViewingFile(null)
  }

  const handleFileClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      navigateToDir(entry.name)
    } else {
      setViewingFile(entry.rel_path)
      readFileFn(entry.rel_path)
    }
  }

  const goBack = () => {
    if (viewingFile) {
      setViewingFile(null)
      return
    }
    if (pathStack.length > 0) {
      navigateToDir('..')
    }
  }

  // Viewing a file's content
  if (viewingFile) {
    return (
      <div className="flex flex-col gap-3 animate-in">
        <div className="flex items-center gap-2">
          <button
            className="text-sm text-primary font-medium"
            onClick={goBack}
          >
            ← 返回
          </button>
          <span className="text-xs text-ink font-mono truncate flex-1">
            {viewingFile}
          </span>
        </div>
        {fileContentData && fileContentData.path === viewingFile ? (
          <div className="card">
            {fileContentData.encoding === 'binary' ? (
              <p className="text-xs text-ink-dim text-center py-4">
                二进制文件，无法预览
              </p>
            ) : (
              <pre className="text-[11px] text-ink font-mono whitespace-pre-wrap break-words overflow-auto max-h-[60vh] leading-relaxed">
                {fileContentData.content}
              </pre>
            )}
          </div>
        ) : (
          <div className="card-flat flex items-center justify-center py-8">
            <span className="text-xs text-ink-faint animate-pulse">
              加载中…
            </span>
          </div>
        )}
      </div>
    )
  }

  // Directory listing
  return (
    <div className="flex flex-col gap-3 animate-in">
      {/* Breadcrumb / path display */}
      <div className="flex items-center gap-2">
        {pathStack.length > 0 && (
          <button
            className="text-sm text-primary font-medium shrink-0"
            onClick={goBack}
          >
            ← 上级
          </button>
        )}
        <span className="text-[11px] text-ink-muted font-mono truncate flex-1">
          {fileRoot ? shortPath(fileRoot) : '工作目录'}
          {pathStack.length > 0 && ` / ${pathStack.join('/')}`}
        </span>
        <button
          className="text-[11px] text-primary font-medium shrink-0 disabled:opacity-40"
          disabled={disabled || fileBrowsing}
          onClick={() => listFilesFn(pathStack.join('/') || undefined)}
        >
          刷新
        </button>
      </div>

      {/* Entry list or prompt to browse */}
      {fileEntries.length === 0 && !fileBrowsing ? (
        <div className="card-flat flex flex-col items-center py-10 text-ink-faint">
          <span className="text-3xl mb-2">📂</span>
          <p className="text-xs">浏览桌面端文件</p>
          <p className="text-[10px] mt-1 mb-3">
            点击下方按钮查看桌面端的工作目录
          </p>
          <button
            className="px-4 py-2 rounded-xl bg-primary text-white text-xs font-medium disabled:opacity-40"
            disabled={disabled}
            onClick={() => listFilesFn()}
          >
            浏览根目录
          </button>
        </div>
      ) : fileBrowsing ? (
        <div className="card-flat flex items-center justify-center py-8">
          <span className="text-xs text-ink-faint animate-pulse">
            加载目录…
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {/* Directories first, then files */}
          {[...fileEntries]
            .sort((a, b) => {
              if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((entry) => (
              <button
                key={entry.rel_path}
                className="card-flat flex items-center gap-3 py-2.5 px-3 text-left active:bg-surface-2 transition-colors w-full"
                onClick={() => handleFileClick(entry)}
              >
                <span className="text-sm shrink-0">
                  {entry.is_dir ? '📁' : fileIcon(entry.ext)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-ink truncate">
                    {entry.name}
                  </p>
                  {!entry.is_dir && (
                    <p className="text-[10px] text-ink-faint">
                      {fileSize(entry.size)}
                      {entry.ext ? ` · .${entry.ext}` : ''}
                    </p>
                  )}
                </div>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-ink-faint shrink-0"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

function fileIcon(ext: string): string {
  if (!ext) return '📄'
  const map: Record<string, string> = {
    rs: '🦀',
    ts: '🟦',
    tsx: '🟦',
    js: '🟨',
    jsx: '🟨',
    json: '📋',
    toml: '⚙️',
    md: '📝',
    py: '🐍',
    html: '🌐',
    css: '🎨',
    sql: '🗃️',
    sh: '🐚',
    yml: '⚙️',
    yaml: '⚙️',
    png: '🖼️',
    jpg: '🖼️',
    svg: '🖼️',
    lock: '🔒',
  }
  return map[ext.toLowerCase()] ?? '📄'
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Chat Panel                                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

function ChatPanel() {
  const chatSessions = useSyncStore((s) => s.chatSessions)
  const chatMessages = useSyncStore((s) => s.chatMessages)
  const sendChatMessage = useSyncStore((s) => s.sendChatMessage)
  const wsState = useSyncStore((s) => s.wsState)
  const disabled = wsState !== 'connected'

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const selectedSession = chatSessions.find((s) => s.id === selectedId) ?? null
  const sessionMessages = selectedId
    ? chatMessages
        .filter((m) => m.session_id === selectedId)
        .sort(
          (a, b) =>
            new Date(a.created_at).getTime() -
            new Date(b.created_at).getTime()
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

  if (!selectedId) {
    return (
      <div className="flex flex-col gap-2 animate-in">
        {chatSessions.length === 0 ? (
          <div className="card-flat flex flex-col items-center py-10 text-ink-faint">
            <span className="text-3xl mb-2">💬</span>
            <p className="text-xs">桌面端暂无对话</p>
            <p className="text-[10px] mt-1">
              在桌面端开始对话后，会话列表会同步到此处
            </p>
          </div>
        ) : (
          chatSessions.map((sess) => {
            const lastMsg = chatMessages
              .filter((m) => m.session_id === sess.id)
              .sort(
                (a, b) =>
                  new Date(b.created_at).getTime() -
                  new Date(a.created_at).getTime()
              )[0]
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
                  <p className="text-sm text-ink font-medium truncate">
                    {sess.title || '未命名对话'}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {sess.model && (
                      <span className="text-[10px] text-ink-faint font-mono truncate">
                        {sess.model}
                      </span>
                    )}
                    {lastMsg && (
                      <span className="text-[10px] text-ink-faint truncate">
                        {lastMsg.content.slice(0, 40)}
                      </span>
                    )}
                  </div>
                </div>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-ink-faint shrink-0"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )
          })
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full animate-in" style={{ minHeight: 0 }}>
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

      <div
        className="flex-1 overflow-auto flex flex-col gap-2 mb-3"
        style={{ maxHeight: '55vh' }}
      >
        {sessionMessages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-ink-faint py-8">
            暂无消息
          </div>
        ) : (
          sessionMessages.map((msg) => (
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

      <div className="flex gap-2 items-center shrink-0">
        <input
          className="flex-1 bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-ink outline-none placeholder-ink-faint focus:border-primary transition-colors"
          placeholder={disabled ? '未连接' : '发送消息到桌面端…'}
          disabled={disabled}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
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
  const wsState = useSyncStore((s) => s.wsState)
  const loggedIn = useAuthStore((s) => s.loggedIn)
  const tasks = useSyncStore((s) => s.tasks)
  const unreadCount = useSyncStore((s) => s.unreadCount)
  const [tab, setTab] = useState<Tab>('tasks')

  const ws = WS_LABELS[wsState] ?? WS_LABELS.disconnected
  const runningTasks = tasks.filter((t) => t.status === 'dispatched').length

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
    { key: 'files', label: '文件' },
    { key: 'chat', label: '对话' },
  ]

  return (
    <div className="page">
      {/* Header */}
      <div
        className="page-header"
        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      >
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
          <span className="text-[11px] text-ink-dim font-medium">
            {ws.text}
          </span>
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
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key)
              if (t.key === 'events')
                useSyncStore.getState().clearEvents()
            }}
            style={{
              flex: 1,
              padding: '10px 0',
              fontSize: 13,
              fontWeight: tab === t.key ? 600 : 500,
              color:
                tab === t.key ? 'var(--primary)' : 'var(--text-dim)',
              background: 'transparent',
              border: 'none',
              borderBottom:
                tab === t.key
                  ? '2px solid var(--primary)'
                  : '2px solid transparent',
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
                  right: '20%',
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
        {tab === 'files' && <FilePanel />}
        {tab === 'chat' && <ChatPanel />}
      </div>
    </div>
  )
}
