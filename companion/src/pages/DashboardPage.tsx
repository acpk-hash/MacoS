import { useState } from 'react'
import { useSyncStore, Task, AgentEvent } from '../stores/syncStore'
import StatusDot from '../components/StatusDot'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const statusColors: Record<Task['status'], string> = {
  todo: 'bg-ink-faint/20 text-ink-dim',
  dispatched: 'bg-sky/10 text-sky',
  done: 'bg-mint/10 text-mint',
  error: 'bg-coral/10 text-coral',
}

const statusLabels: Record<Task['status'], string> = {
  todo: '待办',
  dispatched: '进行中',
  done: '完成',
  error: '错误',
}

function TaskCard({ task }: { task: Task }) {
  const sendCommand = useSyncStore((s) => s.sendCommand)

  return (
    <div className="bg-editor rounded-xl border border-line p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-ink leading-snug flex-1">{task.title}</p>
        <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColors[task.status]}`}>
          {statusLabels[task.status]}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-faint">{relativeTime(task.created_at)}</span>
        <div className="flex gap-2">
          {task.status === 'todo' && (
            <button
              onClick={() => sendCommand('dispatch_task', { task_id: task.id })}
              className="text-xs px-3 py-1.5 rounded-lg bg-sky/10 text-sky font-medium active:bg-sky/20 transition-colors"
            >
              派发
            </button>
          )}
          {task.status === 'dispatched' && (
            <button
              onClick={() => sendCommand('complete_task', { task_id: task.id })}
              className="text-xs px-3 py-1.5 rounded-lg bg-mint/10 text-mint font-medium active:bg-mint/20 transition-colors"
            >
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: AgentEvent }) {
  const typeColors: Record<string, string> = {
    assistant_message: 'text-mint',
    command_run: 'text-sky',
    file_edit: 'text-gold',
    turn_completed: 'text-ink-faint',
    error: 'text-coral',
  }

  const color = typeColors[event.type] ?? 'text-ink-muted'
  const label = event.summary ?? event.cmd ?? event.path ?? event.type

  return (
    <div className="flex gap-2 items-baseline py-1">
      <span className={`text-[10px] font-bold shrink-0 ${color}`}>
        {event.type.replace('_', ' ').toUpperCase()}
      </span>
      <span className="text-xs text-ink-muted truncate">{label}</span>
    </div>
  )
}

export default function DashboardPage() {
  const wsState = useSyncStore((s) => s.wsState)
  const tasks = useSyncStore((s) => s.tasks)
  const events = useSyncStore((s) => s.events)
  const createTask = useSyncStore((s) => s.createTask)
  const [showInput, setShowInput] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  function handleCreate() {
    const title = newTitle.trim()
    if (!title) return
    createTask(title)
    setNewTitle('')
    setShowInput(false)
  }

  const recentEvents = events.slice(0, 10)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-ink">任务</h1>
          <StatusDot state={wsState} />
        </div>
        <span className="text-sm text-ink-muted">{tasks.length} 个任务</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-3">
        {/* Inline create input */}
        {showInput && (
          <div className="bg-editor rounded-xl border border-line p-3 flex gap-2">
            <input
              autoFocus
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="任务标题…"
              className="flex-1 text-sm bg-transparent text-ink placeholder-ink-faint focus:outline-none"
            />
            <button
              onClick={handleCreate}
              className="text-sm px-3 py-1 rounded-lg bg-primary text-white font-medium"
            >
              添加
            </button>
            <button
              onClick={() => setShowInput(false)}
              className="text-sm px-2 py-1 rounded-lg text-ink-muted"
            >
              取消
            </button>
          </div>
        )}

        {/* Task list */}
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <p className="text-sm">暂无任务</p>
          </div>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}

        {/* Events feed */}
        {recentEvents.length > 0 && (
          <div className="mt-2">
            <h2 className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2">近期事件</h2>
            <div className="bg-editor rounded-xl border border-line px-3 py-2 divide-y divide-line">
              {recentEvents.map((ev) => (
                <EventRow key={ev.id} event={ev} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* FAB */}
      <button
        onClick={() => setShowInput(true)}
        className="fixed bottom-20 right-4 w-14 h-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center active:bg-primary-hover transition-colors"
        style={{ bottom: 'calc(56px + env(safe-area-inset-bottom, 0px) + 16px)' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  )
}
