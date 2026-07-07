import React, { useEffect, useRef, useState } from 'react'
import {
  useAgentStore,
  type FileEditInfo,
  type FileEditStatus,
  type TaskRow,
  type TimelineEntry,
  loadHistory,
  restoreSession,
} from '../stores/agentStore'

// ── Tauri environment guard ───────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── Simple markdown renderer (no heavy libs) ──────────────────────────────────

function renderText(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {line}
    </React.Fragment>
  ))
}

function renderMarkdown(text: string): React.ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
      return (
        <pre
          key={i}
          className="bg-gray-950 rounded p-2 mt-1 mb-1 text-xs font-mono overflow-x-auto whitespace-pre-wrap"
        >
          {code}
        </pre>
      )
    }
    return <span key={i}>{renderText(part)}</span>
  })
}

// ── Streaming cursor (embedded engine live typing) ────────────────────────────

/** Blinking caret appended to the in-progress assistant bubble, matching the
 *  StudioChat streaming style. */
function BlinkCursor() {
  return (
    <span className="inline-block w-[7px] h-[15px] ml-0.5 -mb-0.5 bg-gray-300 animate-pulse rounded-[1px] align-middle" />
  )
}

// ── Diff viewer ───────────────────────────────────────────────────────────────

function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="text-xs font-mono overflow-x-auto leading-relaxed select-text">
      {lines.map((line, i) => {
        // Header lines (--- / +++ / @@)
        if (line.startsWith('---') || line.startsWith('+++')) {
          return (
            <div key={i} className="text-gray-500">
              {line}
            </div>
          )
        }
        if (line.startsWith('@@')) {
          return (
            <div key={i} className="text-gray-500 bg-gray-900 px-1">
              {line}
            </div>
          )
        }
        if (line.startsWith('+')) {
          return (
            <div key={i} className="bg-green-950/60 text-green-300 px-1">
              {line}
            </div>
          )
        }
        if (line.startsWith('-')) {
          return (
            <div key={i} className="bg-red-950/60 text-red-300 px-1">
              {line}
            </div>
          )
        }
        return (
          <div key={i} className="text-gray-400 px-1">
            {line}
          </div>
        )
      })}
    </pre>
  )
}

// ── File edit row (in diff panel) ─────────────────────────────────────────────

function FileEditRow({
  info,
  onApprove,
  onRevert,
}: {
  info: FileEditInfo
  onApprove: (path: string) => void
  onRevert: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const filename = info.path.split(/[\\/]/).pop() ?? info.path
  const statusColor: Record<FileEditStatus, string> = {
    pending: 'text-yellow-400',
    approved: 'text-green-400',
    reverted: 'text-gray-500',
  }
  const statusLabel: Record<FileEditStatus, string> = {
    pending: '待审',
    approved: '已批准',
    reverted: '已回滚',
  }

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      {/* File header row */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-gray-900 cursor-pointer hover:bg-gray-800 transition-colors select-none"
        onClick={() => info.diff && setExpanded((v) => !v)}
      >
        <span className="text-gray-300 text-xs font-mono truncate flex-1" title={info.path}>
          {filename}
        </span>

        {/* +/- badges */}
        {(info.added > 0 || info.removed > 0) && (
          <span className="flex-shrink-0 text-xs font-mono gap-1 flex">
            {info.added > 0 && (
              <span className="text-green-400">+{info.added}</span>
            )}
            {info.removed > 0 && (
              <span className="text-red-400">−{info.removed}</span>
            )}
          </span>
        )}

        {/* Status badge */}
        <span className={`flex-shrink-0 text-xs ${statusColor[info.status]}`}>
          {statusLabel[info.status]}
        </span>

        {/* Expand toggle */}
        {info.diff && (
          <span className="flex-shrink-0 text-gray-600 text-xs">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </div>

      {/* Diff content */}
      {expanded && info.diff && (
        <div className="bg-gray-950 border-t border-gray-800 max-h-80 overflow-y-auto p-2">
          <DiffViewer diff={info.diff} />
        </div>
      )}

      {/* Action buttons */}
      {info.status === 'pending' && (
        <div className="flex gap-2 px-3 py-2 border-t border-gray-800 bg-gray-900/50">
          <button
            onClick={() => onApprove(info.path)}
            className="text-xs px-2 py-1 rounded bg-green-900/50 hover:bg-green-800/70 text-green-300 border border-green-800 transition-colors"
          >
            批准
          </button>
          <button
            onClick={() => onRevert(info.path)}
            className="text-xs px-2 py-1 rounded bg-red-900/50 hover:bg-red-800/70 text-red-300 border border-red-800 transition-colors"
          >
            回滚
          </button>
        </div>
      )}
    </div>
  )
}

// ── Diff panel (right sidebar) ────────────────────────────────────────────────

function DiffPanel({
  sessionId,
  fileEdits,
}: {
  sessionId: string
  fileEdits: Map<string, FileEditInfo>
}) {
  const { setFileEditStatus } = useAgentStore()
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null)

  const files = Array.from(fileEdits.values())
  const pendingFiles = files.filter((f) => f.status === 'pending')

  const handleApprove = async (path: string) => {
    try {
      await tauriInvoke<void>('file_approve', { sessionId, path })
    } catch (e) {
      console.warn('[DiffPanel] file_approve failed:', e)
    }
    setFileEditStatus(sessionId, path, 'approved')
  }

  const handleRevertRequest = (path: string) => {
    setConfirmRevert(path)
  }

  const handleRevertConfirm = async () => {
    if (!confirmRevert) return
    const path = confirmRevert
    setConfirmRevert(null)
    try {
      await tauriInvoke<void>('file_revert', { sessionId, path })
      setFileEditStatus(sessionId, path, 'reverted')
    } catch (e) {
      console.error('[DiffPanel] file_revert failed:', e)
      alert(`回滚失败: ${e}`)
    }
  }

  const handleApproveAll = async () => {
    for (const f of pendingFiles) {
      await handleApprove(f.path)
    }
  }

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-600 text-xs select-none">暂无文件改动</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-gray-400 font-medium flex-1">
          本次改动 ({files.length})
        </span>
        {pendingFiles.length > 0 && (
          <button
            onClick={handleApproveAll}
            className="text-xs px-2 py-0.5 rounded bg-green-900/50 hover:bg-green-800/70 text-green-300 border border-green-800 transition-colors whitespace-nowrap"
          >
            全部批准
          </button>
        )}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {files.map((info) => (
          <FileEditRow
            key={info.path}
            info={info}
            onApprove={handleApprove}
            onRevert={handleRevertRequest}
          />
        ))}
      </div>

      {/* Revert confirm dialog */}
      {confirmRevert && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-gray-200 mb-1 font-medium">确认回滚？</p>
            <p className="text-xs text-gray-400 mb-4 font-mono break-all">
              {confirmRevert}
            </p>
            <p className="text-xs text-gray-500 mb-4">
              此操作会将文件恢复到本会话开始前的状态，无法撤销。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmRevert(null)}
                className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleRevertConfirm}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white border border-red-600 transition-colors"
              >
                确认回滚
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Timeline entry components ─────────────────────────────────────────────────

function EntryView({
  entry,
  onToggleExpand,
}: {
  entry: TimelineEntry
  onToggleExpand: () => void
}) {
  switch (entry.kind) {
    case 'user_message':
      return (
        <div className="flex justify-end">
          <div className="max-w-lg px-4 py-2.5 rounded-2xl rounded-br-sm bg-blue-600 text-white text-sm leading-relaxed break-words">
            {renderText(entry.text)}
          </div>
        </div>
      )

    case 'assistant_message':
      return (
        <div className="flex justify-start">
          <div className="max-w-lg px-4 py-2.5 rounded-2xl rounded-bl-sm bg-gray-800 text-gray-200 text-sm leading-relaxed break-words">
            {renderMarkdown(entry.text)}
          </div>
        </div>
      )

    case 'file_edit': {
      const filename = entry.path.split(/[\\/]/).pop() ?? entry.path
      return (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-0.5 pl-1">
          <span aria-hidden="true">✏️</span>
          <span>
            修改{' '}
            <code className="text-blue-400 font-mono" title={entry.path}>
              {filename}
            </code>
          </span>
          <span className="text-gray-600 capitalize">{entry.editKind}</span>
          {(entry.added > 0 || entry.removed > 0) && (
            <span className="font-mono">
              {entry.added > 0 && (
                <span className="text-green-500">+{entry.added}</span>
              )}
              {entry.removed > 0 && (
                <span className="text-red-500 ml-0.5">−{entry.removed}</span>
              )}
            </span>
          )}
        </div>
      )
    }

    case 'command_run': {
      const isSuccess = entry.exitCode === 0
      const shortCmd =
        entry.cmd.length > 120 ? entry.cmd.slice(0, 120) + '…' : entry.cmd
      return (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-2 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 flex-shrink-0" aria-hidden="true">
              ▶
            </span>
            <span className="text-gray-300 flex-1 truncate" title={entry.cmd}>
              {shortCmd}
            </span>
            <span
              className={[
                'flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-sans font-medium',
                isSuccess
                  ? 'bg-green-900/60 text-green-400'
                  : 'bg-red-900/60 text-red-400',
              ].join(' ')}
            >
              {entry.exitCode}
            </span>
            {entry.outputTail && (
              <button
                onClick={onToggleExpand}
                className="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
                title={entry.expanded ? '收起输出' : '展开输出'}
              >
                {entry.expanded ? '▲' : '▼'}
              </button>
            )}
          </div>
          {entry.expanded && entry.outputTail && (
            <pre className="mt-2 text-gray-400 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto border-t border-gray-800 pt-2">
              {entry.outputTail}
            </pre>
          )}
        </div>
      )
    }

    case 'usage':
      return (
        <div className="text-xs text-gray-600 text-center py-0.5">
          tokens — in {entry.inputTokens.toLocaleString()} (cached{' '}
          {entry.cachedInputTokens.toLocaleString()}) / out{' '}
          {entry.outputTokens.toLocaleString()} / reasoning{' '}
          {entry.reasoningOutputTokens.toLocaleString()}
        </div>
      )

    case 'error':
      return (
        <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-2 text-red-400 text-sm break-words">
          {entry.message}
        </div>
      )

    default:
      return null
  }
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/70 text-blue-300 border border-blue-800">
        运行中
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/70 text-green-300 border border-green-800">
        已完成
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/70 text-red-300 border border-red-800">
        出错
      </span>
    )
  }
  return null
}

// ── Session list (left sidebar) ───────────────────────────────────────────────

function statusBadgeClass(status: string): string {
  if (status === 'running') return 'bg-blue-900/70 text-blue-300 border-blue-800'
  if (status === 'failed') return 'bg-red-900/70 text-red-300 border-red-800'
  if (status === 'awaiting_review') return 'bg-yellow-900/70 text-yellow-300 border-yellow-800'
  return 'bg-green-900/70 text-green-300 border-green-800'
}

function statusLabel(status: string): string {
  if (status === 'running') return '运行中'
  if (status === 'failed') return '出错'
  if (status === 'awaiting_review') return '待审'
  return '完成'
}

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

function SessionListPanel({
  tasks,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: {
  tasks: TaskRow[]
  activeSessionId: string | null
  onSelectSession: (task: TaskRow) => void
  onNewSession: () => void
}) {
  return (
    <div className="flex flex-col w-52 flex-shrink-0 border-r border-gray-800 h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-1 flex-shrink-0">
        <span className="text-xs text-gray-400 font-medium flex-1">会话历史</span>
        <button
          onClick={onNewSession}
          className="text-xs px-2 py-0.5 rounded bg-blue-900/50 hover:bg-blue-800/70 text-blue-300 border border-blue-800 transition-colors whitespace-nowrap"
          title="新会话"
        >
          + 新
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto py-1">
        {tasks.length === 0 && (
          <p className="text-gray-600 text-xs text-center mt-4 px-2 select-none">暂无历史</p>
        )}
        {tasks.map((task) => {
          const isActive = (task.last_session_id ?? task.id) === activeSessionId
          return (
            <button
              key={task.id}
              onClick={() => onSelectSession(task)}
              className={[
                'w-full text-left px-3 py-2 border-b border-gray-800/50 transition-colors',
                isActive
                  ? 'bg-blue-900/30 border-l-2 border-l-blue-500'
                  : 'hover:bg-gray-800/60',
              ].join(' ')}
            >
              {/* Title */}
              <p
                className="text-xs text-gray-200 leading-snug line-clamp-2 break-words"
                title={task.title}
              >
                {task.title || '(无标题)'}
              </p>

              {/* Meta row */}
              <div className="flex items-center gap-1.5 mt-1">
                <span
                  className={`text-[10px] px-1 py-0 rounded border ${statusBadgeClass(task.status)}`}
                >
                  {statusLabel(task.status)}
                </span>
                <span className="text-[10px] text-gray-600">
                  {relativeTime(task.updated_at)}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Chat component ───────────────────────────────────────────────────────

export default function Chat() {
  const {
    sessions,
    activeSessionId,
    historyTasks,
    createSession,
    setActiveSession,
    addUserMessage,
    markSessionRunning,
    toggleCommandExpanded,
  } = useAgentStore()

  const [workdir, setWorkdir] = useState('')
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const [diffPanelOpen, setDiffPanelOpen] = useState(true)
  const [confirmPolicy, setConfirmPolicy] = useState<string>('auto')

  const timelineEndRef = useRef<HTMLDivElement>(null)

  const activeSession = activeSessionId ? sessions[activeSessionId] : null
  const isRunning = activeSession?.status === 'running' || sending
  const canSendFollowup =
    activeSessionId != null &&
    (activeSession?.status === 'done' ||
      activeSession?.status === 'error' ||
      // Allow followup on restored historical sessions too
      (sessions[activeSessionId] != null && !isRunning))

  // Load history and settings on mount.
  useEffect(() => {
    if (isTauri) {
      loadHistory()
      // Load confirmation policy setting for badge display.
      tauriInvoke<Record<string, string>>('settings_get_all')
        .then((all) => {
          if (all['confirmation_policy']) {
            setConfirmPolicy(all['confirmation_policy'])
          }
          // Load default_workdir as initial workdir if workdir is unset.
          if (all['default_workdir'] && !workdir) {
            setWorkdir(all['default_workdir'])
          }
        })
        .catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom when new entries arrive or the streaming buffer grows.
  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeSession?.entries.length, activeSession?.streamingText])

  // ── Session selection ──────────────────────────────────────────────────────

  const handleSelectSession = async (task: TaskRow) => {
    // Use the most recent session id; fall back to task.id for tasks created
    // the old way (where task.id === session.id).
    const sessionId = task.last_session_id ?? task.id
    // If already loaded in store, just switch to it.
    if (sessions[sessionId]) {
      setActiveSession(sessionId)
      return
    }
    // Otherwise load from DB timeline.
    await restoreSession(sessionId, task.status)
    // After restore, also update workdir input to match the session's workdir.
    setWorkdir(task.workdir)
  }

  // ── Non-Tauri fallback UI ──────────────────────────────────────────────────
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

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleNewSession = () => {
    setActiveSession(null)
    setInputText('')
    setWorkdir('')
  }

  const handleBrowse = async () => {
    try {
      const selected = await tauriInvoke<string | null>('pick_directory')
      if (selected) {
        setWorkdir(selected)
      }
    } catch (e) {
      console.warn('[Chat] pick_directory failed:', e)
    }
  }

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || isRunning) return

    setInputText('')
    setSending(true)

    try {
      if (!activeSessionId || !sessions[activeSessionId]) {
        // ── Start a new session ──
        const sessionId = await tauriInvoke<string>('agent_start', {
          prompt: text,
          workdir: workdir.trim() || '.',
        })
        createSession(sessionId)
        addUserMessage(sessionId, text)
        // Refresh sidebar to show the new task.
        loadHistory()
      } else if (canSendFollowup) {
        // ── Send a follow-up turn (hot or cold resume) ──
        addUserMessage(activeSessionId, text)
        markSessionRunning(activeSessionId)
        await tauriInvoke<void>('agent_followup', {
          sessionId: activeSessionId,
          text,
        })
      }
    } catch (err) {
      console.error('[Chat] send failed:', err)
    } finally {
      setSending(false)
    }
  }

  const handleCancel = async () => {
    if (!activeSessionId || !isRunning) return
    try {
      await tauriInvoke<void>('agent_cancel', { sessionId: activeSessionId })
    } catch (err) {
      console.error('[Chat] cancel failed:', err)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const entries = activeSession?.entries ?? []
  const fileEdits = activeSession?.fileEdits ?? new Map()
  const hasFileEdits = fileEdits.size > 0
  // Live streaming buffer (embedded engine only; empty for CLI mode).
  const streamingText = activeSession?.streamingText ?? ''

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full">
      {/* ── Far left: session history list ─────────────────────────────────── */}
      <SessionListPanel
        tasks={historyTasks}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
      />

      {/* ── Center: chat column ────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 h-full">
        {/* ── Top bar ────────────────────────────────────────────────────────── */}
        <div className="px-4 py-2 border-b border-gray-800 flex-shrink-0 flex items-center gap-2 min-h-[44px]">
          <input
            type="text"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="选择 agent 工作目录"
            className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
          />

          {/* Browse button */}
          <button
            onClick={handleBrowse}
            className="flex-shrink-0 text-xs px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 transition-colors whitespace-nowrap"
            title="选择工作目录"
          >
            浏览…
          </button>

          {/* Confirmation policy badge (read-only display; set in Settings) */}
          <span
            className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-gray-700
                       text-gray-500 bg-gray-800/60 whitespace-nowrap"
            title="确认策略（在设置中修改）即将生效"
          >
            {confirmPolicy === 'per_file' ? '逐文件批准' : '自动执行'}
          </span>

          {activeSession && <StatusBadge status={activeSession.status} />}

          {isRunning && (
            <button
              onClick={handleCancel}
              className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800 text-red-300 border border-red-800 transition-colors whitespace-nowrap"
            >
              取消
            </button>
          )}

          {/* Toggle diff panel */}
          {hasFileEdits && (
            <button
              onClick={() => setDiffPanelOpen((v) => !v)}
              className="flex-shrink-0 text-xs px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 transition-colors whitespace-nowrap"
              title={diffPanelOpen ? '收起改动面板' : '展开改动面板'}
            >
              {diffPanelOpen ? '收起改动' : '本次改动'}
            </button>
          )}
        </div>

        {/* ── Timeline ──────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {entries.length === 0 && !streamingText ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-600 text-sm select-none">
                输入提示词开始新会话
              </p>
            </div>
          ) : (
            entries.map((entry, idx) => (
              <EntryView
                key={idx}
                entry={entry}
                onToggleExpand={() =>
                  activeSessionId &&
                  toggleCommandExpanded(activeSessionId, idx)
                }
              />
            ))
          )}

          {/* Live streaming bubble: the in-progress assistant turn rendered
              token-by-token (embedded engine). Replaced by the final
              assistant_message entry when the turn text lands. */}
          {streamingText && (
            <div className="flex justify-start">
              <div className="max-w-lg px-4 py-2.5 rounded-2xl rounded-bl-sm bg-gray-800 text-gray-200 text-sm leading-relaxed break-words">
                {renderMarkdown(streamingText)}
                <BlinkCursor />
              </div>
            </div>
          )}

          <div ref={timelineEndRef} />
        </div>

        {/* ── Input area ────────────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-t border-gray-800 flex-shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              rows={2}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isRunning
                  ? 'Agent 运行中，请稍候…'
                  : '输入提示词，Enter 发送，Shift+Enter 换行…'
              }
              disabled={isRunning}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50 transition-colors"
            />
            <button
              onClick={handleSend}
              disabled={isRunning || !inputText.trim()}
              className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              发送
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: diff panel ──────────────────────────────────────────────── */}
      {hasFileEdits && diffPanelOpen && activeSessionId && (
        <div className="w-72 flex-shrink-0 border-l border-gray-800 flex flex-col h-full">
          <DiffPanel sessionId={activeSessionId} fileEdits={fileEdits} />
        </div>
      )}
    </div>
  )
}
