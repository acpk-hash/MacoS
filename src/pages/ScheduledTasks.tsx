// 定时任务 — cron 调度页面：前端 localStorage 持久化 + setInterval 轮询触发。
// 任务到期时通过 chat_sessions_create + chat_send 走后端模型通道执行。
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'

// ── Tauri helpers ────────────────────────────────────────────────────────────

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

// ── StudioEvent listener (reused pattern from other stores) ──────────────────

interface StudioEvent {
  type: string
  session_id?: string
  message_id?: string
  text?: string
  status?: string
  message?: string
  input_tokens?: number
  output_tokens?: number
}

interface PendingRun {
  taskId: string
  sessionId: string
  buf: string
  resolve: (text: string) => void
  reject: (err: Error) => void
}

const pendingRuns = new Map<string, PendingRun>()
let listenerReady = false

async function ensureListener(): Promise<void> {
  if (listenerReady || !isTauri) return
  listenerReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      if (!p.session_id) return
      const run = pendingRuns.get(p.session_id)
      if (!run) return
      switch (p.type) {
        case 'delta':
          run.buf += p.text ?? ''
          break
        case 'done':
          pendingRuns.delete(p.session_id)
          run.resolve(p.text || run.buf)
          break
        case 'error':
          pendingRuns.delete(p.session_id)
          run.reject(new Error(p.message ?? '执行出错'))
          break
        default:
          break
      }
    })
  } catch (err) {
    listenerReady = false
    console.warn('[scheduledTasks] failed to register studio-event listener:', err)
  }
}

// ── Cron utilities ───────────────────────────────────────────────────────────

/** Supported cron: min hour dom month dow (5-field). */
function getNextRun(cron: string, after: Date): Date | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minPart, hourPart, domPart, , dowPart] = parts

  // Start scanning from `after` + 1 minute, minute by minute up to 400 days.
  const start = new Date(after)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const limit = 400 * 24 * 60 // max iterations
  const d = new Date(start)
  for (let i = 0; i < limit; i++) {
    if (matchesCronField(dowPart, d.getDay()) &&
        matchesCronField(domPart, d.getDate()) &&
        matchesCronField(hourPart, d.getHours()) &&
        matchesCronField(minPart, d.getMinutes())) {
      return d
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

function matchesCronField(field: string, value: number): boolean {
  if (field === '*') return true
  // */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    return !isNaN(step) && step > 0 && value % step === 0
  }
  // comma-separated values
  return field.split(',').some((v) => parseInt(v, 10) === value)
}

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [minP, hourP, domP, , dowP] = parts

  // Every N minutes
  if (minP.startsWith('*/') && hourP === '*' && domP === '*' && dowP === '*') {
    const n = parseInt(minP.slice(2), 10)
    if (n === 1) return '每分钟'
    return `每 ${n} 分钟`
  }
  // Daily at H:MM
  if (!minP.startsWith('*') && !hourP.startsWith('*') && domP === '*' && dowP === '*') {
    return `每天 ${hourP.padStart(2, '0')}:${minP.padStart(2, '0')}`
  }
  // Weekly: specific dow
  if (!minP.startsWith('*') && !hourP.startsWith('*') && domP === '*' && dowP !== '*') {
    const dayNames = ['日', '一', '二', '三', '四', '五', '六']
    const day = parseInt(dowP, 10)
    const dayStr = day >= 0 && day <= 6 ? `周${dayNames[day]}` : `第${dowP}天`
    return `每${dayStr} ${hourP.padStart(2, '0')}:${minP.padStart(2, '0')}`
  }
  // Monthly: specific dom
  if (!minP.startsWith('*') && !hourP.startsWith('*') && domP !== '*' && dowP === '*') {
    return `每月${domP}日 ${hourP.padStart(2, '0')}:${minP.padStart(2, '0')}`
  }
  // Hourly
  if (!minP.startsWith('*') && hourP === '*' && domP === '*' && dowP === '*') {
    return `每小时 :${minP.padStart(2, '0')}`
  }
  return cron
}

// ── Data types ───────────────────────────────────────────────────────────────

interface TaskRunRecord {
  id: string
  startTime: string
  endTime: string | null
  status: 'running' | 'done' | 'error'
  outputPreview: string
}

interface ScheduledTask {
  id: string
  name: string
  prompt: string
  cron: string
  enabled: boolean
  workDir: string
  notify: boolean
  createdAt: string
  lastRun: string | null
  lastStatus: 'done' | 'error' | null
  nextRun: string | null
  history: TaskRunRecord[]
}

const STORAGE_KEY = 'iris-scheduled-tasks'

function loadTasks(): ScheduledTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveTasks(tasks: ScheduledTask[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ── Presets ──────────────────────────────────────────────────────────────────

interface Preset {
  name: string
  prompt: string
  cron: string
  label: string
}

const PRESETS: Preset[] = [
  {
    name: '每日简报',
    prompt: '请帮我生成今日简报，包含我关注领域的重要进展、待办事项提醒、以及值得注意的新闻摘要。',
    cron: '0 9 * * *',
    label: '每天 09:00',
  },
  {
    name: '每周总结',
    prompt: '请帮我总结本周的工作进展，列出完成的任务、未完成的任务、遇到的问题和下周的计划建议。',
    cron: '0 17 * * 5',
    label: '每周五 17:00',
  },
  {
    name: '定时检查',
    prompt: '请检查项目的运行状态，包括是否有异常日志、资源使用情况、以及需要关注的潜在问题。',
    cron: '0 */3 * * *',
    label: '每 3 小时',
  },
]

// ── Schedule picker options ─────────────────────────────────────────────────

type ScheduleMode = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

const SCHEDULE_MODES: { value: ScheduleMode; label: string }[] = [
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义 Cron' },
]

const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// ── Styles (Iris design tokens) ──────────────────────────────────────────────

const inputCls =
  'w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60'
const btnPrimaryCls =
  'rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors disabled:opacity-40'
const btnGhostCls =
  'rounded-input border border-line bg-transparent px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors'
const cardCls = 'rounded-card border border-line bg-surface p-3'

// ── Format helpers ──────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string {
  if (!iso) return '--'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '--'
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return `今天 ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function fmtDuration(start: string, end: string | null): string {
  if (!end) return '运行中...'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

// ── SVG icons (inline, matching codebase convention) ─────────────────────────

function IconPlus({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function IconPlay({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  )
}

function IconTrash({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <polyline points="3,6 5,6 21,6" /><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
    </svg>
  )
}

function IconClock({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" />
    </svg>
  )
}

function IconChevron({ size = 14, open }: { size?: number; open: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
      <polyline points="9,6 15,12 9,18" />
    </svg>
  )
}

function IconCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <polyline points="20,6 9,17 4,12" />
    </svg>
  )
}

function IconX({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// ── Toggle switch ────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border transition-colors duration-200 ${
        checked ? 'border-primary/40 bg-primary' : 'border-line bg-surface-2'
      }`}
    >
      <span
        className={`inline-block h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[15px]' : 'translate-x-[1px]'
        }`}
      />
    </button>
  )
}

// ── Create Task Dialog ──────────────────────────────────────────────────────

interface CreateDialogProps {
  open: boolean
  onClose: () => void
  onSave: (task: Omit<ScheduledTask, 'id' | 'createdAt' | 'lastRun' | 'lastStatus' | 'nextRun' | 'history'>) => void
  initial?: Preset | null
}

function CreateTaskDialog({ open, onClose, onSave, initial }: CreateDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [mode, setMode] = useState<ScheduleMode>('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [dow, setDow] = useState(1) // Monday
  const [dom, setDom] = useState(1)
  const [intervalMin, setIntervalMin] = useState(30)
  const [customCron, setCustomCron] = useState('0 9 * * *')
  const [workDir, setWorkDir] = useState('')
  const [notify, setNotify] = useState(true)

  useEffect(() => {
    if (open && initial) {
      setName(initial.name)
      setPrompt(initial.prompt)
      // Parse initial cron to set mode
      const parts = initial.cron.trim().split(/\s+/)
      if (parts.length === 5) {
        const [m, h, d, , w] = parts
        if (h === '*' && m.startsWith('*/')) {
          setMode('hourly')
          setIntervalMin(parseInt(m.slice(2), 10) || 30)
        } else if (d === '*' && w === '*') {
          setMode('daily')
          setHour(parseInt(h, 10) || 9)
          setMinute(parseInt(m, 10) || 0)
        } else if (d === '*' && w !== '*') {
          setMode('weekly')
          setHour(parseInt(h, 10) || 9)
          setMinute(parseInt(m, 10) || 0)
          setDow(parseInt(w, 10) || 1)
        } else if (d !== '*' && w === '*') {
          setMode('monthly')
          setHour(parseInt(h, 10) || 9)
          setMinute(parseInt(m, 10) || 0)
          setDom(parseInt(d, 10) || 1)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  if (!open) return null

  const buildCron = (): string => {
    switch (mode) {
      case 'hourly':
        return `*/${intervalMin} * * * *`
      case 'daily':
        return `${minute} ${hour} * * *`
      case 'weekly':
        return `${minute} ${hour} * * ${dow}`
      case 'monthly':
        return `${minute} ${hour} ${dom} * *`
      case 'custom':
        return customCron
    }
  }

  const cronPreview = cronToHuman(buildCron())

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return
    onSave({
      name: name.trim(),
      prompt: prompt.trim(),
      cron: buildCron(),
      enabled: true,
      workDir: workDir.trim(),
      notify,
    })
    // Reset form
    setName('')
    setPrompt('')
    setMode('daily')
    setHour(9)
    setMinute(0)
    setWorkDir('')
    setNotify(true)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-card border border-line bg-bg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">创建定时任务</h2>
          <button onClick={onClose} className="text-ink-dim hover:text-ink transition-colors">
            <IconX size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-4 py-4">
          {/* Task name */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-dim">任务名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：每日简报"
              className={inputCls}
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-dim">执行指令</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="AI 将执行的任务指令..."
              rows={3}
              className={inputCls + ' resize-none'}
            />
          </div>

          {/* Schedule picker */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-dim">执行计划</label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {SCHEDULE_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`rounded-input px-2.5 py-1 text-[11px] transition-colors ${
                    mode === m.value
                      ? 'bg-primary text-white'
                      : 'border border-line bg-surface-2 text-ink-dim hover:text-ink hover:bg-surface'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Mode-specific controls */}
            {mode === 'hourly' && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-ink-dim">每</span>
                <input
                  type="number"
                  min={1}
                  max={59}
                  value={intervalMin}
                  onChange={(e) => setIntervalMin(Math.max(1, Math.min(59, parseInt(e.target.value) || 1)))}
                  className={inputCls + ' !w-16 text-center'}
                />
                <span className="text-[12px] text-ink-dim">分钟</span>
              </div>
            )}

            {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (
              <div className="flex flex-wrap items-center gap-2">
                {mode === 'weekly' && (
                  <select
                    value={dow}
                    onChange={(e) => setDow(parseInt(e.target.value))}
                    className={inputCls + ' !w-24'}
                  >
                    {DOW_LABELS.map((label, i) => (
                      <option key={i} value={i}>{label}</option>
                    ))}
                  </select>
                )}
                {mode === 'monthly' && (
                  <div className="flex items-center gap-1">
                    <span className="text-[12px] text-ink-dim">每月第</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={dom}
                      onChange={(e) => setDom(Math.max(1, Math.min(31, parseInt(e.target.value) || 1)))}
                      className={inputCls + ' !w-14 text-center'}
                    />
                    <span className="text-[12px] text-ink-dim">日</span>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                    className={inputCls + ' !w-14 text-center'}
                  />
                  <span className="text-[12px] text-ink-dim">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                    className={inputCls + ' !w-14 text-center'}
                  />
                </div>
              </div>
            )}

            {mode === 'custom' && (
              <input
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="分 时 日 月 周  例如: 0 9 * * 1-5"
                className={inputCls}
              />
            )}

            {/* Preview */}
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-muted">
              <IconClock size={11} />
              <span>{cronPreview}</span>
            </div>
          </div>

          {/* Optional: working directory */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-dim">
              工作目录 <span className="text-ink-faint font-normal">(可选)</span>
            </label>
            <input
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder="留空则使用默认目录"
              className={inputCls}
            />
          </div>

          {/* Notify toggle */}
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-ink-dim">完成时通知</span>
            <Toggle checked={notify} onChange={setNotify} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button onClick={onClose} className={btnGhostCls}>取消</button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !prompt.trim()}
            className={btnPrimaryCls}
          >
            创建任务
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Task Card ────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: ScheduledTask
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onRunNow: (id: string) => void
  running: boolean
}

function TaskCard({ task, onToggle, onDelete, onRunNow, running }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const statusChip = task.lastStatus === 'done'
    ? 'text-done bg-[#10a37f1a] border-[#10a37f40]'
    : task.lastStatus === 'error'
      ? 'text-failed bg-[#d0342c1a] border-[#d0342c40]'
      : 'text-ink-dim bg-surface-2 border-line'

  const statusText = task.lastStatus === 'done'
    ? '成功'
    : task.lastStatus === 'error'
      ? '失败'
      : '未运行'

  return (
    <div className={`${cardCls} ${!task.enabled ? 'opacity-60' : ''}`}>
      {/* Top row */}
      <div className="flex items-start gap-3">
        {/* Toggle */}
        <div className="pt-0.5">
          <Toggle checked={task.enabled} onChange={() => onToggle(task.id)} />
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink truncate">{task.name}</span>
            {running && (
              <span className="rounded-chip border border-[#0d8de340] bg-[#0d8de31a] px-1.5 py-0.5 text-[10px] text-running font-medium">
                运行中
              </span>
            )}
            <span className={`rounded-chip border px-1.5 py-0.5 text-[10px] font-medium ${statusChip}`}>
              {statusText}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-dim">
            <span className="flex items-center gap-1">
              <IconClock size={10} />
              {cronToHuman(task.cron)}
            </span>
            <span>上次: {fmtTime(task.lastRun)}</span>
            <span>下次: {fmtTime(task.nextRun)}</span>
          </div>

          <div className="mt-1.5 text-[11px] text-ink-muted line-clamp-2" title={task.prompt}>
            {task.prompt}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => onRunNow(task.id)}
            disabled={running}
            className="rounded-input p-1.5 text-ink-dim hover:text-primary hover:bg-primary-tint transition-colors disabled:opacity-40"
            title="立即运行"
          >
            <IconPlay size={12} />
          </button>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded-input p-1.5 text-ink-dim hover:text-failed hover:bg-[#d0342c14] transition-colors"
              title="删除任务"
            >
              <IconTrash size={12} />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onDelete(task.id)}
                className="rounded-input p-1 text-failed hover:bg-[#d0342c14] transition-colors"
                title="确认删除"
              >
                <IconCheck size={12} />
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-input p-1 text-ink-dim hover:bg-surface-2 transition-colors"
                title="取消"
              >
                <IconX size={12} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* History section */}
      {task.history.length > 0 && (
        <div className="mt-2.5 border-t border-line pt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[11px] text-ink-dim hover:text-ink transition-colors"
          >
            <IconChevron size={11} open={expanded} />
            执行记录 ({task.history.length})
          </button>

          {expanded && (
            <div className="mt-2 space-y-1.5 max-h-[200px] overflow-y-auto">
              {task.history.slice().reverse().map((run) => (
                <div key={run.id} className="flex items-start gap-2 rounded bg-editor px-2 py-1.5 text-[11px]">
                  <span
                    className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      run.status === 'done'
                        ? 'bg-done'
                        : run.status === 'error'
                          ? 'bg-failed'
                          : 'bg-running animate-pulse'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-ink-dim">
                      <span>{fmtTime(run.startTime)}</span>
                      <span>{fmtDuration(run.startTime, run.endTime)}</span>
                    </div>
                    {run.outputPreview && (
                      <div className="mt-0.5 text-ink-muted line-clamp-2 break-all">{run.outputPreview}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function ScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>(() => loadTasks())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [presetInit, setPresetInit] = useState<Preset | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Persist whenever tasks change.
  useEffect(() => {
    saveTasks(tasks)
  }, [tasks])

  // Recalculate nextRun for all tasks when they change.
  const recalcNextRun = useCallback((taskList: ScheduledTask[]): ScheduledTask[] => {
    const now = new Date()
    return taskList.map((t) => {
      if (!t.enabled) return { ...t, nextRun: null }
      const next = getNextRun(t.cron, now)
      return { ...t, nextRun: next ? next.toISOString() : null }
    })
  }, [])

  // On mount: ensure nextRun is calculated.
  useEffect(() => {
    setTasks((prev) => recalcNextRun(prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Task execution ──────────────────────────────────────────────────────

  const executeTask = useCallback(async (taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId)
    if (!task) return

    const runId = uuid()
    const startTime = new Date().toISOString()

    // Mark as running
    setRunningIds((s) => new Set(s).add(taskId))
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              history: [...t.history, { id: runId, startTime, endTime: null, status: 'running' as const, outputPreview: '' }],
            }
          : t,
      ),
    )

    let output = ''
    let status: 'done' | 'error' = 'done'

    if (isTauri) {
      try {
        await ensureListener()

        // Create a hidden session.
        const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
          title: `[定时] ${task.name}`,
          model: null as unknown as string, // use default model
        })
        const sessionId = row.id

        const promise = new Promise<string>((resolve, reject) => {
          pendingRuns.set(sessionId, {
            taskId,
            sessionId,
            buf: '',
            resolve,
            reject,
          })
        })

        await tauriInvoke<string>('chat_send', {
          sessionId,
          userContent: task.prompt,
          attachments: [],
          model: null,
          providerId: null,
        })

        output = await promise
      } catch (e) {
        status = 'error'
        output = e instanceof Error ? e.message : String(e)
      }
    } else {
      // Non-Tauri fallback: simulate
      await new Promise((r) => setTimeout(r, 1500))
      output = `[模拟] 任务「${task.name}」已在非桌面环境中模拟执行。`
    }

    const endTime = new Date().toISOString()
    const preview = output.slice(0, 300)

    // Update task state
    setRunningIds((s) => {
      const next = new Set(s)
      next.delete(taskId)
      return next
    })
    setTasks((prev) =>
      recalcNextRun(
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                lastRun: endTime,
                lastStatus: status,
                history: t.history.map((h) =>
                  h.id === runId
                    ? { ...h, endTime, status, outputPreview: preview }
                    : h,
                ),
              }
            : t,
        ),
      ),
    )

    // Notification
    if (task.notify && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`定时任务: ${task.name}`, {
        body: status === 'done' ? '执行完成' : `执行失败: ${preview.slice(0, 100)}`,
      })
    }
  }, [recalcNextRun])

  // ── Scheduler: check every 30 seconds ──────────────────────────────────

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date()
      const current = tasksRef.current
      for (const task of current) {
        if (!task.enabled || !task.nextRun) continue
        if (runningIds.has(task.id)) continue
        const nextTime = new Date(task.nextRun)
        if (now >= nextTime) {
          void executeTask(task.id)
        }
      }
    }, 30_000)
    return () => clearInterval(interval)
  }, [executeTask, runningIds])

  // ── Request notification permission ────────────────────────────────────

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleCreate = useCallback(
    (data: Omit<ScheduledTask, 'id' | 'createdAt' | 'lastRun' | 'lastStatus' | 'nextRun' | 'history'>) => {
      const now = new Date()
      const next = data.enabled ? getNextRun(data.cron, now) : null
      const newTask: ScheduledTask = {
        id: uuid(),
        ...data,
        createdAt: now.toISOString(),
        lastRun: null,
        lastStatus: null,
        nextRun: next ? next.toISOString() : null,
        history: [],
      }
      setTasks((prev) => [...prev, newTask])
    },
    [],
  )

  const handleToggle = useCallback(
    (id: string) => {
      setTasks((prev) =>
        recalcNextRun(
          prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)),
        ),
      )
    },
    [recalcNextRun],
  )

  const handleDelete = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const handleRunNow = useCallback(
    (id: string) => {
      void executeTask(id)
    },
    [executeTask],
  )

  const openPreset = useCallback((preset: Preset) => {
    setPresetInit(preset)
    setDialogOpen(true)
  }, [])

  const openCreate = useCallback(() => {
    setPresetInit(null)
    setDialogOpen(true)
  }, [])

  // ── Stats ─────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const total = tasks.length
    const active = tasks.filter((t) => t.enabled).length
    const totalRuns = tasks.reduce((s, t) => s + t.history.length, 0)
    const errors = tasks.reduce(
      (s, t) => s + t.history.filter((h) => h.status === 'error').length,
      0,
    )
    return { total, active, totalRuns, errors }
  }, [tasks])

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-ink">定时任务</h1>
            <p className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">
              创建 Cron 调度任务，定时自动执行 AI 指令。任务在应用运行期间按计划触发。
            </p>
          </div>
          <button onClick={openCreate} className={btnPrimaryCls + ' flex items-center gap-1.5'}>
            <IconPlus size={12} />
            新建任务
          </button>
        </div>

        {/* Stats bar */}
        {tasks.length > 0 && (
          <div className="mb-5 grid grid-cols-4 gap-3">
            <div className={cardCls}>
              <div className="text-[11px] text-ink-dim">总任务</div>
              <div className="mt-0.5 text-lg font-semibold text-ink">{stats.total}</div>
            </div>
            <div className={cardCls}>
              <div className="text-[11px] text-ink-dim">运行中</div>
              <div className="mt-0.5 text-lg font-semibold text-primary">{stats.active}</div>
            </div>
            <div className={cardCls}>
              <div className="text-[11px] text-ink-dim">累计执行</div>
              <div className="mt-0.5 text-lg font-semibold text-ink">{stats.totalRuns}</div>
            </div>
            <div className={cardCls}>
              <div className="text-[11px] text-ink-dim">失败次数</div>
              <div className="mt-0.5 text-lg font-semibold text-failed">{stats.errors}</div>
            </div>
          </div>
        )}

        {/* Quick presets */}
        {tasks.length === 0 && (
          <section className="mb-6">
            <h2 className="text-[13px] font-semibold text-ink mb-3">快速模板</h2>
            <div className="grid grid-cols-3 gap-3">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => openPreset(preset)}
                  className={`${cardCls} text-left hover:border-primary/40 transition-colors group`}
                >
                  <div className="text-[13px] font-medium text-ink group-hover:text-primary transition-colors">
                    {preset.name}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-dim flex items-center gap-1">
                    <IconClock size={10} />
                    {preset.label}
                  </div>
                  <div className="mt-1.5 text-[11px] text-ink-muted line-clamp-2">
                    {preset.prompt}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Presets row (shown when tasks exist) */}
        {tasks.length > 0 && (
          <div className="mb-5 flex items-center gap-2">
            <span className="text-[11px] text-ink-dim shrink-0">快速添加:</span>
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => openPreset(preset)}
                className="rounded-input border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink-dim hover:text-ink hover:bg-surface transition-colors"
              >
                {preset.name}
              </button>
            ))}
          </div>
        )}

        {/* Task list */}
        {tasks.length > 0 ? (
          <div className="space-y-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onToggle={handleToggle}
                onDelete={handleDelete}
                onRunNow={handleRunNow}
                running={runningIds.has(task.id)}
              />
            ))}
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center justify-center text-center">
            <div className="text-ink-faint mb-3">
              <IconClock size={40} />
            </div>
            <p className="text-[13px] text-ink-dim">暂无定时任务</p>
            <p className="mt-1 text-[11px] text-ink-muted">
              点击上方模板快速创建，或使用「新建任务」自定义调度。
            </p>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <CreateTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleCreate}
        initial={presetInit}
      />
    </div>
  )
}
