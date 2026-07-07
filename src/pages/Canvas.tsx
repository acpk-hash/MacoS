import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore, loadHistory } from '../stores/agentStore'
import { buildFlow } from '../components/canvas/buildFlow'
import type {
  CanvasEventRow,
  CanvasSessionRow,
  FlowSession,
  FlowStep,
  NodeStatus,
} from '../components/canvas/types'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

function taskDot(status: string): string {
  if (status === 'running') return 'bg-blue-400 canvas-glow'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'awaiting_review') return 'bg-amber-400'
  if (status === 'done') return 'bg-green-500'
  return 'bg-gray-500'
}

function statusDot(status: NodeStatus): string {
  if (status === 'running') return 'bg-blue-400 canvas-glow'
  if (status === 'failed') return 'bg-red-500'
  return 'bg-green-500'
}

function statusText(status: NodeStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  return '已完成'
}

function statusPill(status: NodeStatus): string {
  if (status === 'running') return 'bg-blue-600/30 text-blue-300'
  if (status === 'failed') return 'bg-red-600/30 text-red-300'
  return 'bg-green-600/30 text-green-300'
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return String(ms)
  }
}

const KIND_META: Record<FlowStep['stepKind'], { label: string; color: string }> = {
  reply: { label: '回复', color: 'text-sky-300' },
  command: { label: '命令', color: 'text-emerald-300' },
  file: { label: '文件', color: 'text-purple-300' },
}

function StepCard({
  step,
  expanded,
  onToggle,
}: {
  step: FlowStep
  expanded: boolean
  onToggle: () => void
}) {
  const meta = KIND_META[step.stepKind]
  return (
    <div className="relative pl-6">
      <span
        className={`absolute left-[6px] top-3 w-2 h-2 rounded-full ${statusDot(
          step.status,
        )}`}
      />
      <button
        onClick={onToggle}
        className={`w-full text-left rounded-lg border bg-gray-900 hover:bg-gray-800/70 transition-colors px-3 py-2 ${
          step.status === 'failed' ? 'border-red-600/50' : 'border-gray-800'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold ${meta.color}`}>{meta.label}</span>
          {step.stepKind === 'command' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                step.exitCode === 0
                  ? 'bg-green-600/30 text-green-300'
                  : 'bg-red-600/30 text-red-300'
              }`}
            >
              exit {step.exitCode}
            </span>
          )}
          {step.stepKind === 'file' && (
            <span className="text-[10px] font-mono">
              <span className="text-green-400">+{step.added ?? 0}</span>{' '}
              <span className="text-red-400">-{step.removed ?? 0}</span>
            </span>
          )}
          <span className="ml-auto text-[10px] text-gray-600">{fmtTime(step.ts)}</span>
        </div>

        <div className="mt-1 text-[12px] text-gray-300">
          {step.stepKind === 'reply' && (
            <span className="line-clamp-2 whitespace-pre-wrap break-words">
              {step.text || '（空回复）'}
            </span>
          )}
          {step.stepKind === 'command' && (
            <code className="block font-mono break-all line-clamp-2">
              {step.cmd || '（空命令）'}
            </code>
          )}
          {step.stepKind === 'file' && (
            <code className="block font-mono break-all line-clamp-1 text-gray-400">
              {step.path}
            </code>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-1 mb-2 rounded-lg border border-gray-800 bg-gray-950 p-3 text-[12px] text-gray-300 space-y-2">
          {step.stepKind === 'reply' && (
            <pre className="whitespace-pre-wrap break-words leading-relaxed">
              {step.text || '（空回复）'}
            </pre>
          )}
          {step.stepKind === 'command' && (
            <>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">命令</div>
                <pre className="font-mono whitespace-pre-wrap break-all bg-gray-900 rounded p-2">
                  {step.cmd}
                </pre>
              </div>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">输出（末尾）</div>
                <pre className="font-mono whitespace-pre-wrap break-all bg-gray-900 rounded p-2 max-h-72 overflow-auto text-gray-400 text-[11px]">
                  {step.outputTail || '（无输出）'}
                </pre>
              </div>
            </>
          )}
          {step.stepKind === 'file' && (
            <>
              <div className="font-mono break-all text-gray-200">{step.path}</div>
              <div className="text-[11px] text-gray-500">变更类型：{step.changeKind}</div>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">差异</div>
                <pre className="font-mono whitespace-pre bg-gray-900 rounded p-2 max-h-96 overflow-auto text-[11px]">
                  {step.diff || '（无差异内容）'}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SessionBlock({
  sess,
  expanded,
  onToggleStep,
}: {
  sess: FlowSession
  expanded: Set<string>
  onToggleStep: (id: string) => void
}) {
  return (
    <div className="border border-gray-800 rounded-xl bg-gray-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900/60">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(sess.status)}`} />
        <span className="text-[12px] font-semibold text-gray-200">
          会话 #{sess.index + 1}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/30 text-indigo-300 font-mono">
          {sess.engine}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusPill(sess.status)}`}>
          {statusText(sess.status)}
        </span>
        <span className="ml-auto text-[11px] text-gray-500">{sess.stepCount} 步</span>
      </div>

      {sess.status === 'failed' && sess.errorText && (
        <div className="px-3 py-2 text-[11px] text-red-400 whitespace-pre-wrap break-all border-b border-gray-800">
          {sess.errorText}
        </div>
      )}

      <div className="p-3 space-y-1.5">
        {sess.steps.length === 0 ? (
          <div className="text-[11px] text-gray-600 pl-6">暂无步骤</div>
        ) : (
          <div className="relative">
            <span className="absolute left-[10px] top-2 bottom-2 w-px bg-gray-800" />
            <div className="space-y-1.5">
              {sess.steps.map((st) => (
                <StepCard
                  key={st.id}
                  step={st}
                  expanded={expanded.has(st.id)}
                  onToggle={() => onToggleStep(st.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Canvas() {
  const historyTasks = useAgentStore((s) => s.historyTasks)
  const storeSessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<CanvasSessionRow[]>([])
  const [eventsMap, setEventsMap] = useState<Record<string, CanvasEventRow[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadHistory()
  }, [])

  const prevActive = useRef<string | null>(null)
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActive.current) {
      prevActive.current = activeSessionId
      const t = historyTasks.find(
        (t) => t.id === activeSessionId || t.last_session_id === activeSessionId,
      )
      setSelectedTaskId(t ? t.id : activeSessionId)
    }
  }, [activeSessionId, historyTasks])

  useEffect(() => {
    if (!selectedTaskId && historyTasks.length > 0) {
      setSelectedTaskId(historyTasks[0].id)
    }
  }, [historyTasks, selectedTaskId])

  const loadGraph = useCallback(async (taskId: string) => {
    if (!isTauri) return
    try {
      const sess = await invokeTauri<CanvasSessionRow[]>('get_task_sessions', {
        taskId,
      })
      const map: Record<string, CanvasEventRow[]> = {}
      await Promise.all(
        sess.map(async (s) => {
          map[s.id] = await invokeTauri<CanvasEventRow[]>('get_session_events', {
            sessionId: s.id,
          })
        }),
      )
      setSessions(sess)
      setEventsMap(map)
    } catch (err) {
      console.warn('[canvas] loadGraph failed:', err)
    }
  }, [])

  useEffect(() => {
    if (selectedTaskId) void loadGraph(selectedTaskId)
  }, [selectedTaskId, loadGraph])

  const liveSig = sessions
    .map((s) => {
      const ss = storeSessions[s.id]
      return ss ? `${ss.status}:${ss.entries.length}` : ''
    })
    .join('|')

  useEffect(() => {
    if (selectedTaskId && liveSig.replace(/\|/g, '') !== '') {
      void loadGraph(selectedTaskId)
      void loadHistory()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSig])

  const storeStatus = useMemo(() => {
    const m: Record<string, string | undefined> = {}
    for (const s of sessions) m[s.id] = storeSessions[s.id]?.status
    return m
  }, [sessions, storeSessions])

  const flow = useMemo(
    () => buildFlow({ sessions, eventsMap, storeStatus }),
    [sessions, eventsMap, storeStatus],
  )

  const anyRunning = flow.some((s) => s.status === 'running')

  useEffect(() => {
    if (anyRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSig])

  const toggleStep = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedTask = historyTasks.find((t) => t.id === selectedTaskId)
  const empty = historyTasks.length === 0

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-100">
      <header className="px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-sm font-semibold">执行流</h1>
        <p className="text-[11px] text-gray-500">
          Agent 执行过程的只读可视化视图（会话 · 命令 · 文件 · 回复）。要主动改本地文件，请用「工作台」。
        </p>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-56 border-r border-gray-800 bg-gray-900/60 overflow-y-auto flex-shrink-0">
          <div className="px-3 py-2 text-[11px] text-gray-500 sticky top-0 bg-gray-900/90">
            任务列表
          </div>
          {historyTasks.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelectedTaskId(t.id)
                setExpanded(new Set())
              }}
              className={`w-full text-left px-3 py-2 border-b border-gray-800/60 hover:bg-gray-800/60 transition-colors ${
                selectedTaskId === t.id ? 'bg-gray-800' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${taskDot(t.status)}`}
                />
                <span className="text-xs truncate">{t.title || '未命名任务'}</span>
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5 pl-4">
                {t.session_count} 会话 · {t.file_count} 文件
              </div>
            </button>
          ))}
        </aside>

        <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="text-5xl mb-4 opacity-40">🗺️</div>
              <p className="text-gray-400 text-sm">
                派发一个任务，在这里看 Agent 怎么干活
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
              {selectedTask && (
                <div className="text-[13px] font-medium text-gray-200">
                  {selectedTask.title || '未命名任务'}
                </div>
              )}
              {flow.length === 0 ? (
                <div className="text-[12px] text-gray-600">该任务暂无会话记录</div>
              ) : (
                flow.map((sess) => (
                  <SessionBlock
                    key={sess.id}
                    sess={sess}
                    expanded={expanded}
                    onToggleStep={toggleStep}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
