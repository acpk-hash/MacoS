import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore, loadHistory } from '../stores/agentStore'
import { buildFlow } from '../components/canvas/buildFlow'
import SessionBlock from '../components/canvas/SessionBlock'
import type {
  CanvasEventRow,
  CanvasSessionRow,
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
  if (status === 'running') return 'bg-sky canvas-glow'
  if (status === 'failed') return 'bg-failed'
  if (status === 'awaiting_review') return 'bg-awaiting'
  if (status === 'done') return 'bg-done'
  return 'bg-ink-dim'
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
    <div className="h-full flex flex-col bg-bg text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <h1 className="text-sm font-semibold">执行流</h1>
        <p className="text-[11px] text-ink-dim">
          Agent 执行过程的只读可视化视图（会话 · 命令 · 文件 · 回复）。要主动改本地文件，请用「工作台」。
        </p>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-56 border-r border-line bg-surface/60 overflow-y-auto flex-shrink-0">
          <div className="px-3 py-2 text-[11px] text-ink-dim sticky top-0 bg-surface/90">
            任务列表
          </div>
          {historyTasks.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelectedTaskId(t.id)
                setExpanded(new Set())
              }}
              className={`w-full text-left px-3 py-2 border-b border-line/60 hover:bg-surface-2/60 transition-colors ${
                selectedTaskId === t.id ? 'bg-surface-2' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${taskDot(t.status)}`}
                />
                <span className="text-xs truncate">{t.title || '未命名任务'}</span>
              </div>
              <div className="text-[10px] text-ink-dim mt-0.5 pl-4">
                {t.session_count} 会话 · {t.file_count} 文件
              </div>
            </button>
          ))}
        </aside>

        <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="text-5xl mb-4 opacity-40">🗺️</div>
              <p className="text-ink-muted text-sm">
                派发一个任务，在这里看 Agent 怎么干活
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
              {selectedTask && (
                <div className="text-[13px] font-medium text-ink">
                  {selectedTask.title || '未命名任务'}
                </div>
              )}
              {flow.length === 0 ? (
                <div className="text-[12px] text-ink-dim">该任务暂无会话记录</div>
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
