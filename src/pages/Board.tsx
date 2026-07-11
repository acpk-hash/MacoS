import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mascot, StatusDot } from '../components/ui'
import {
  useAgentStore,
  type Session,
  type TaskRow,
  loadHistory,
  restoreSession,
} from '../stores/agentStore'

// ── Tauri env guard ───────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s <= 0) return '刚才'
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h 前`
  return `${Math.floor(h / 24)}d 前`
}

function workdirTail(workdir: string): string {
  if (!workdir || workdir === '.') return '.'
  const parts = workdir.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || workdir
}

/** Return a one-line summary of the latest meaningful event in a session. */
function getLatestEventSummary(session: Session | undefined): string {
  if (!session) return ''
  const entries = [...session.entries].reverse()
  for (const e of entries) {
    if (e.kind === 'assistant_message') {
      const first = e.text.split('\n')[0]
      return first.length > 80 ? first.slice(0, 80) + '…' : first
    }
    if (e.kind === 'command_run') {
      const cmd = e.cmd.length > 60 ? e.cmd.slice(0, 60) + '…' : e.cmd
      return `$ ${cmd}`
    }
    if (e.kind === 'file_edit') {
      const name = e.path.split(/[\\/]/).pop() ?? e.path
      return `编辑 ${name}`
    }
  }
  return ''
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className="fixed bottom-5 right-5 z-50 bg-surface-2 border border-line text-ink text-sm px-4 py-3 rounded-xl shadow-xl max-w-xs">
      {message}
    </div>
  )
}

// ── Card components ───────────────────────────────────────────────────────────

interface TodoCardProps {
  task: TaskRow
  onDispatch: (task: TaskRow) => void
  onDelete: (task: TaskRow) => void
  onRenameCommit: (task: TaskRow, newTitle: string) => void
}

function TodoCard({ task, onDispatch, onDelete, onRenameCommit }: TodoCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(task.title)
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const commitEdit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== task.title) {
      onRenameCommit(task, trimmed)
    }
    setEditing(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitEdit()
    if (e.key === 'Escape') setEditing(false)
  }

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('task-id', task.id)}
      className="glass rounded-card px-3 py-2.5 select-none transition-all duration-150 hover:-translate-y-0.5 hover:border-line-strong"
    >
      {/* Title row */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          className="w-full bg-elevated border border-lavender rounded px-2 py-0.5 text-sm text-ink focus:outline-none"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <p
          className="text-sm text-ink leading-snug line-clamp-2 cursor-text"
          onClick={startEdit}
          title={task.title}
        >
          {task.title || '（无标题）'}
        </p>
      )}

      {/* Workdir + time */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="text-[10px] text-ink-dim font-mono truncate max-w-[80px]" title={task.workdir}>
          {workdirTail(task.workdir)}
        </span>
        <span className="text-[10px] text-ink-dim">{relativeTime(task.created_at)}</span>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mt-2">
        <button
          onClick={(e) => { e.stopPropagation(); onDispatch(task) }}
          className="flex-1 text-xs px-2 py-1 rounded-lg bg-sakura/60 hover:bg-sakura/80 text-sky border border-lavender transition-colors"
        >
          派发
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task) }}
          className="text-xs px-2 py-1 rounded-lg bg-elevated hover:bg-red-900/60 text-ink-muted hover:text-failed border border-line hover:border-[#f8514940] transition-colors"
          title="删除任务"
        >
          删
        </button>
      </div>
    </div>
  )
}

interface RunningCardProps {
  task: TaskRow
  session: Session | undefined
  onClick: () => void
}

function RunningCard({ task, session, onClick }: RunningCardProps) {
  const isFailed = task.status === 'failed'
  const summary = getLatestEventSummary(session)

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('task-id', task.id)}
      onClick={onClick}
      className={[
        'glass rounded-card px-3 py-2.5 cursor-pointer select-none transition-all duration-150 hover:-translate-y-0.5',
        isFailed
          ? 'border-[#f8514940] hover:border-failed'
          : 'border-line hover:border-line-strong',
      ].join(' ')}
    >
      {/* Failed badge */}
      {isFailed && (
        <div className="flex items-center gap-1 mb-1.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-900/70 text-failed border border-[#f8514940]">
            出错
          </span>
        </div>
      )}

      {/* Running indicator */}
      {!isFailed && (
        <div className="flex items-center gap-1.5 mb-1">
          <StatusDot status="running" size={7} pulse />
          <span className="text-[10px] text-sky">运行中</span>
        </div>
      )}

      <p className="text-sm text-ink leading-snug line-clamp-2" title={task.title}>
        {task.title || '（无标题）'}
      </p>

      {/* Latest event summary */}
      {summary && !isFailed && (
        <p className="text-[10px] text-ink-dim mt-1 truncate" title={summary}>
          {summary}
        </p>
      )}

      {/* Meta */}
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-[10px] text-ink-dim font-mono truncate max-w-[70px]" title={task.workdir}>
          {workdirTail(task.workdir)}
        </span>
        <span className="text-[10px] text-ink-dim">{relativeTime(task.updated_at)}</span>
        {task.file_count > 0 && (
          <span className="ml-auto text-[10px] bg-elevated text-ink-muted px-1.5 py-0.5 rounded-full">
            {task.file_count} 文件
          </span>
        )}
      </div>
    </div>
  )
}

interface ReviewCardProps {
  task: TaskRow
  onClick: () => void
}

function ReviewCard({ task, onClick }: ReviewCardProps) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('task-id', task.id)}
      onClick={onClick}
      className="glass rounded-card border-gold/30 px-3 py-2.5 cursor-pointer select-none transition-all duration-150 hover:-translate-y-0.5 hover:border-gold/50"
    >
      <div className="flex items-center gap-1 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-900/60 text-yellow-300 border border-yellow-800">
          待确认
        </span>
        {task.file_count > 0 && (
          <span className="ml-auto text-[10px] bg-elevated text-ink-muted px-1.5 py-0.5 rounded-full">
            {task.file_count} 文件
          </span>
        )}
      </div>
      <p className="text-sm text-ink leading-snug line-clamp-2" title={task.title}>
        {task.title || '（无标题）'}
      </p>
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="text-[10px] text-ink-dim font-mono truncate max-w-[80px]" title={task.workdir}>
          {workdirTail(task.workdir)}
        </span>
        <span className="text-[10px] text-ink-dim">{relativeTime(task.updated_at)}</span>
      </div>
    </div>
  )
}

interface DoneCardProps {
  task: TaskRow
  onClick: () => void
}

function DoneCard({ task, onClick }: DoneCardProps) {
  return (
    <div
      onClick={onClick}
      className="glass rounded-card px-3 py-2.5 cursor-pointer select-none transition-all duration-150 opacity-70 hover:opacity-100"
    >
      <p className="text-sm text-ink-muted leading-snug line-clamp-2" title={task.title}>
        {task.title || '（无标题）'}
      </p>
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="text-[10px] text-ink-dim font-mono truncate max-w-[80px]" title={task.workdir}>
          {workdirTail(task.workdir)}
        </span>
        <span className="text-[10px] text-ink-dim">{relativeTime(task.updated_at)}</span>
        {task.file_count > 0 && (
          <span className="ml-auto text-[10px] bg-elevated/60 text-ink-dim px-1.5 py-0.5 rounded-full">
            {task.file_count} 文件
          </span>
        )}
      </div>
    </div>
  )
}

// ── Column component ──────────────────────────────────────────────────────────

interface ColumnProps {
  title: string
  count: number
  id: string
  onDragOver: (e: React.DragEvent, colId: string) => void
  onDrop: (e: React.DragEvent, colId: string) => void
  dragOverCol: string | null
  children: React.ReactNode
}

function Column({ title, count, id, onDragOver, onDrop, dragOverCol, children }: ColumnProps) {
  const isOver = dragOverCol === id
  return (
    <div
      className={[
        'w-60 flex-shrink-0 flex flex-col gap-3 rounded-xl transition-colors',
        isOver ? 'bg-surface-2/40 ring-1 ring-lavender/50' : '',
      ].join(' ')}
      onDragOver={(e) => onDragOver(e, id)}
      onDrop={(e) => onDrop(e, id)}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-1 pt-1">
        <h2 className="text-sm font-semibold text-ink-muted">{title}</h2>
        <span className="bg-elevated text-ink-muted text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
          {count}
        </span>
      </div>
      {/* Cards */}
      <div className="flex flex-col gap-2 overflow-y-auto pb-2 px-0.5 min-h-[60px]">
        {children}
      </div>
    </div>
  )
}

// ── New task input bar ────────────────────────────────────────────────────────

interface NewTaskBarProps {
  onCreated: () => void
  onToast: (msg: string) => void
}

function NewTaskBar({ onCreated, onToast }: NewTaskBarProps) {
  const [title, setTitle] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [creating, setCreating] = useState(false)

  const handleBrowse = async () => {
    try {
      const selected = await tauriInvoke<string | null>('pick_directory')
      if (selected) setWorkdir(selected)
    } catch {
      // ignore
    }
  }

  const handleCreate = async () => {
    const t = title.trim()
    if (!t) { onToast('请输入任务标题'); return }
    setCreating(true)
    try {
      await tauriInvoke('task_create', { title: t, workdir: workdir.trim() || '.' })
      setTitle('')
      onCreated()
    } catch (e) {
      onToast(`创建失败: ${e}`)
    } finally {
      setCreating(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleCreate()
  }

  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-line flex-shrink-0">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="输入新任务标题…"
        className="flex-1 min-w-0 bg-surface-2 border border-line rounded-lg px-3 py-1.5 text-sm text-ink placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors"
      />
      <input
        type="text"
        value={workdir}
        onChange={(e) => setWorkdir(e.target.value)}
        placeholder="工作目录"
        className="w-44 flex-shrink-0 bg-surface-2 border border-line rounded-lg px-3 py-1.5 text-xs text-ink placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors"
      />
      <button
        onClick={handleBrowse}
        className="flex-shrink-0 text-xs px-2 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted border border-line transition-colors whitespace-nowrap"
      >
        浏览…
      </button>
      <button
        onClick={handleCreate}
        disabled={creating || !title.trim()}
        className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-sakura hover:bg-sakura disabled:opacity-40 text-white border border-lavender transition-colors whitespace-nowrap"
      >
        + 创建
      </button>
    </div>
  )
}

// ── Main Board component ──────────────────────────────────────────────────────

export default function Board() {
  const navigate = useNavigate()
  const { historyTasks, sessions, createSession } = useAgentStore()

  const [toast, setToast] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<TaskRow | null>(null)
  const [dispatching, setDispatching] = useState<string | null>(null) // task id being dispatched

  const showToast = (msg: string) => setToast(msg)

  // Load history on mount and when navigating back to the board.
  useEffect(() => {
    if (isTauri) loadHistory()
  }, [])

  // ── Bucket tasks by status ─────────────────────────────────────────────────
  const todoTasks = historyTasks.filter((t) => t.status === 'todo')
  const runningTasks = historyTasks.filter((t) => t.status === 'running')
  const failedTasks = historyTasks.filter((t) => t.status === 'failed')
  const reviewTasks = historyTasks.filter((t) => t.status === 'awaiting_review')
  const doneTasks = historyTasks.filter((t) => t.status === 'done')

  // ── Card click: restore session + navigate to /chat ────────────────────────
  const handleCardClick = async (task: TaskRow) => {
    if (!isTauri) return
    const sessionId = task.last_session_id ?? task.id
    if (!sessionId) return
    await restoreSession(sessionId, task.status)
    navigate('/chat')
  }

  // ── Dispatch todo card ─────────────────────────────────────────────────────
  const handleDispatch = async (task: TaskRow) => {
    if (!isTauri) return
    setDispatching(task.id)
    try {
      const sessionId = await tauriInvoke<string>('agent_start', {
        prompt: task.title,
        workdir: task.workdir || '.',
        taskId: task.id,
      })
      createSession(sessionId)
      await loadHistory()
      navigate('/chat')
    } catch (e) {
      showToast(`派发失败: ${e}`)
    } finally {
      setDispatching(null)
    }
  }

  // ── Delete todo card ───────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    const task = confirmDelete
    setConfirmDelete(null)
    try {
      await tauriInvoke('task_delete', { taskId: task.id })
      await loadHistory()
    } catch (e) {
      showToast(`删除失败: ${e}`)
    }
  }

  // ── Rename todo card ───────────────────────────────────────────────────────
  const handleRenameCommit = async (task: TaskRow, newTitle: string) => {
    try {
      await tauriInvoke('task_update_title', { taskId: task.id, title: newTitle })
      await loadHistory()
    } catch (e) {
      showToast(`重命名失败: ${e}`)
    }
  }

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent, colId: string) => {
    e.preventDefault()
    setDragOverCol(colId)
  }

  const handleDrop = async (e: React.DragEvent, colId: string) => {
    e.preventDefault()
    setDragOverCol(null)
    const taskId = e.dataTransfer.getData('task-id')
    if (!taskId) return

    const task = historyTasks.find((t) => t.id === taskId)
    if (!task) return

    // Only awaiting_review → done is allowed.
    if (task.status === 'awaiting_review' && colId === 'done') {
      try {
        await tauriInvoke('task_set_status', { taskId, status: 'done' })
        await loadHistory()
      } catch (e) {
        showToast(`状态更新失败: ${e}`)
      }
    } else if (colId === 'running') {
      showToast('todo 任务必须通过"派发"按钮启动，不能直接拖入进行中')
    } else if (task.status !== 'awaiting_review' || colId !== 'done') {
      showToast(`不允许拖拽：只有"待确认"→"已完成"的转移是合法的`)
    }
  }

  const handleDragEnd = () => setDragOverCol(null)

  // ── Non-Tauri fallback ─────────────────────────────────────────────────────
  if (!isTauri) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-5 py-3 border-b border-line flex-shrink-0">
          <h1 className="text-lg font-bold text-gradient">任务看板</h1>
        </div>
        <div className="flex items-center justify-center flex-1">
          <p className="text-ink-dim text-sm">请在桌面应用中使用</p>
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full" onDragEnd={handleDragEnd}>
      {/* Header */}
      <div className="px-5 py-3 border-b border-line flex-shrink-0">
        <h1 className="text-lg font-bold text-gradient">任务看板</h1>
        <p className="text-xs text-ink-dim mt-0.5">跟踪 Agent 任务执行状态</p>
      </div>

      {/* New task input */}
      <NewTaskBar onCreated={() => loadHistory()} onToast={showToast} />

      {/* Kanban columns */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="flex gap-4 h-full">

          {/* 待办 */}
          <Column
            id="todo"
            title="待办"
            count={todoTasks.length}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            dragOverCol={dragOverCol}
          >
            {todoTasks.map((task) => (
              <div key={task.id} style={{ opacity: dispatching === task.id ? 0.5 : 1 }}>
                <TodoCard
                  task={task}
                  onDispatch={handleDispatch}
                  onDelete={(t) => setConfirmDelete(t)}
                  onRenameCommit={handleRenameCommit}
                />
              </div>
            ))}
            {todoTasks.length === 0 && (
              <div className="flex flex-col items-center mt-6 gap-2 select-none"><Mascot mood="idle" size={44} /><p className="text-xs text-ink-dim">暂无待办任务</p></div>
            )}
          </Column>

          {/* 进行中 (running + failed) */}
          <Column
            id="running"
            title="进行中"
            count={runningTasks.length + failedTasks.length}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            dragOverCol={dragOverCol}
          >
            {runningTasks.map((task) => (
              <RunningCard
                key={task.id}
                task={task}
                session={sessions[task.last_session_id ?? task.id]}
                onClick={() => handleCardClick(task)}
              />
            ))}
            {failedTasks.length > 0 && runningTasks.length > 0 && (
              <div className="border-t border-line my-1" />
            )}
            {failedTasks.map((task) => (
              <RunningCard
                key={task.id}
                task={task}
                session={sessions[task.last_session_id ?? task.id]}
                onClick={() => handleCardClick(task)}
              />
            ))}
            {runningTasks.length === 0 && failedTasks.length === 0 && (
              <div className="flex flex-col items-center mt-6 gap-2 select-none"><Mascot mood="thinking" size={44} /><p className="text-xs text-ink-dim">暂无运行中任务</p></div>
            )}
          </Column>

          {/* 待确认 */}
          <Column
            id="awaiting_review"
            title="待确认"
            count={reviewTasks.length}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            dragOverCol={dragOverCol}
          >
            {reviewTasks.map((task) => (
              <ReviewCard
                key={task.id}
                task={task}
                onClick={() => handleCardClick(task)}
              />
            ))}
            {reviewTasks.length === 0 && (
              <div className="flex flex-col items-center mt-6 gap-2 select-none"><Mascot mood="happy" size={44} /><p className="text-xs text-ink-dim">暂无待确认任务</p></div>
            )}
            <p className="text-[10px] text-ink-dim text-center mt-2 select-none">
              拖至"已完成"以验收
            </p>
          </Column>

          {/* 已完成 */}
          <Column
            id="done"
            title="已完成"
            count={doneTasks.length}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            dragOverCol={dragOverCol}
          >
            {doneTasks.map((task) => (
              <DoneCard
                key={task.id}
                task={task}
                onClick={() => handleCardClick(task)}
              />
            ))}
            {doneTasks.length === 0 && (
              <div className="flex flex-col items-center mt-6 gap-2 select-none"><Mascot mood="happy" size={44} /><p className="text-xs text-ink-dim">暂无已完成任务</p></div>
            )}
          </Column>
        </div>
      </div>

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface border border-line rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-ink mb-1 font-medium">确认删除任务？</p>
            <p className="text-xs text-ink-muted mb-3 line-clamp-2" title={confirmDelete.title}>
              {confirmDelete.title}
            </p>
            <p className="text-xs text-ink-dim mb-4">
              此操作将删除任务及所有关联的会话数据，无法撤销。
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted border border-line transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#da3633] hover:bg-failed text-white border border-failed transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  )
}
