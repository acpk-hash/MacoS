import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  type Node,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useAgentStore, loadHistory } from '../stores/agentStore'
import { TaskNode, SessionNode, StepNode } from '../components/canvas/nodes'
import { buildGraph } from '../components/canvas/buildGraph'
import DetailDrawer from '../components/canvas/DetailDrawer'
import Timeline from '../components/canvas/Timeline'
import type {
  CanvasEventRow,
  CanvasSessionRow,
  DetailEntry,
} from '../components/canvas/types'

// Stable node-type registry (must not be re-created on every render).
const nodeTypes: NodeTypes = {
  taskNode: TaskNode,
  sessionNode: SessionNode,
  stepNode: StepNode,
}

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

function statusDot(status: string): string {
  if (status === 'running') return 'bg-blue-400 canvas-glow'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'awaiting_review') return 'bg-amber-400'
  if (status === 'done') return 'bg-green-500'
  return 'bg-gray-500'
}

function CanvasInner() {
  const historyTasks = useAgentStore((s) => s.historyTasks)
  const storeSessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<CanvasSessionRow[]>([])
  const [eventsMap, setEventsMap] = useState<Record<string, CanvasEventRow[]>>({})
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [drawerEntry, setDrawerEntry] = useState<DetailEntry | null>(null)

  const detailRef = useRef<Map<string, DetailEntry>>(new Map())
  const { setCenter, getNode } = useReactFlow()

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

  // Real-time: when a running session store entries change, re-pull the
  // persisted events for this task and rebuild (reuses the agentStore stream).
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

  const selectedTask = historyTasks.find((t) => t.id === selectedTaskId)

  const { nodes, edges, details, timeline, totalMs, newestNodeId } = useMemo(
    () =>
      buildGraph({
        sessions,
        eventsMap,
        taskTitle: selectedTask?.title ?? '',
        taskStatus: selectedTask?.status ?? '',
        storeStatus,
      }),
    [sessions, eventsMap, selectedTask?.title, selectedTask?.status, storeStatus],
  )

  useEffect(() => {
    detailRef.current = details
  }, [details])

  const rfNodes = useMemo(
    () =>
      nodes.map((n) => (n.id === selectedNodeId ? { ...n, selected: true } : n)),
    [nodes, selectedNodeId],
  )

  const centerNode = useCallback(
    (id: string) => {
      const n = getNode(id)
      if (!n) return
      const w = n.measured?.width ?? 200
      const h = n.measured?.height ?? 90
      void setCenter(n.position.x + w / 2, n.position.y + h / 2, {
        zoom: 1,
        duration: 400,
      })
    },
    [getNode, setCenter],
  )

  const prevNewest = useRef<string | null>(null)
  useEffect(() => {
    if (newestNodeId && newestNodeId !== prevNewest.current) {
      prevNewest.current = newestNodeId
      const t = setTimeout(() => centerNode(newestNodeId), 150)
      return () => clearTimeout(t)
    }
  }, [newestNodeId, centerNode])

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNodeId(node.id)
    setDrawerEntry(detailRef.current.get(node.id) ?? null)
  }, [])

  const onTimelineSelect = useCallback(
    (id: string) => {
      setSelectedNodeId(id)
      centerNode(id)
    },
    [centerNode],
  )

  const empty = historyTasks.length === 0

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-100">
      <header className="px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-sm font-semibold">工作流执行画布</h1>
        <p className="text-[11px] text-gray-500">
          实时观察 Agent 的会话、命令、文件与回复
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
                setDrawerEntry(null)
                setSelectedNodeId(null)
              }}
              className={`w-full text-left px-3 py-2 border-b border-gray-800/60 hover:bg-gray-800/60 transition-colors ${
                selectedTaskId === t.id ? 'bg-gray-800' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(
                    t.status,
                  )}`}
                />
                <span className="text-xs truncate">{t.title || '未命名任务'}</span>
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5 pl-4">
                {t.session_count} 会话 · {t.file_count} 文件
              </div>
            </button>
          ))}
        </aside>

        <div className="flex-1 relative min-w-0">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="text-5xl mb-4 opacity-40">🗺️</div>
              <p className="text-gray-400 text-sm">
                派发一个任务，在这里看 Agent 怎么干活
              </p>
            </div>
          ) : (
            <ReactFlow
              key={selectedTaskId ?? 'none'}
              nodes={rfNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              fitView
              minZoom={0.2}
              maxZoom={1.5}
              nodesDraggable={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
              className="bg-gray-950"
            >
              <Background color="#1f2937" gap={22} />
              <MiniMap
                pannable
                zoomable
                maskColor="rgba(2,6,23,0.7)"
                className="!bg-gray-900 !border !border-gray-800"
                nodeColor="#334155"
              />
              <Controls className="!bg-gray-800 !border-gray-700" />
            </ReactFlow>
          )}

          <DetailDrawer entry={drawerEntry} onClose={() => setDrawerEntry(null)} />
        </div>
      </div>

      <Timeline
        segs={timeline}
        totalMs={totalMs}
        selectedNodeId={selectedNodeId}
        onSelect={onTimelineSelect}
      />
    </div>
  )
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
