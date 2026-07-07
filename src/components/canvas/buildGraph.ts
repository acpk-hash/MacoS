// Pure builder: turn task sessions + persisted events into a React Flow graph.
// Layout is a hand-written left to right layered tree (no layout library).

import type { Edge, Node } from '@xyflow/react'
import type {
  CanvasEventRow,
  CanvasSessionRow,
  DetailEntry,
  NodeStatus,
  StepKind,
  TimelineSeg,
} from './types'

// Layout constants
const COL_TASK_X = 0
const COL_SESSION_X = 300
const STEP_X0 = 580
const STEP_DX = 250
const ROW_H = 190

export interface BuildInput {
  sessions: CanvasSessionRow[]
  eventsMap: Record<string, CanvasEventRow[]>
  taskTitle: string
  taskStatus: string
  /** sessionId to live status from agentStore. */
  storeStatus: Record<string, string | undefined>
}

export interface BuildResult {
  nodes: Node[]
  edges: Edge[]
  details: Map<string, DetailEntry>
  timeline: TimelineSeg[]
  totalMs: number
  /** Id of the step node with the largest ts (for center-on-update). */
  newestNodeId: string | null
}

function parse(row: CanvasEventRow): Record<string, unknown> {
  try {
    return JSON.parse(row.payload_json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function deriveSessionStatus(
  events: CanvasEventRow[],
  storeStat: string | undefined,
  endedAt: number | null,
): NodeStatus {
  if (storeStat === 'running') return 'running'
  const hasError = events.some((e) => e.type === 'error')
  if (hasError || storeStat === 'error') return 'failed'
  if (storeStat === 'done') return 'done'
  const hasCompleted = events.some((e) => e.type === 'turn_completed')
  if (hasCompleted || endedAt != null) return 'done'
  return 'running'
}

function stepLabel(kind: StepKind, data: Record<string, unknown>): string {
  if (kind === 'reply') return `回复：${truncate(String(data.text ?? ''), 40)}`
  if (kind === 'command') return `命令：${String(data.cmd ?? '')}（exit ${data.exitCode}）`
  return `文件：${String(data.path ?? '')} (+${data.added} -${data.removed})`
}

export function buildGraph(input: BuildInput): BuildResult {
  const { sessions, eventsMap, taskTitle, taskStatus, storeStatus } = input

  const nodes: Node[] = []
  const edges: Edge[] = []
  const details = new Map<string, DetailEntry>()
  const timeline: TimelineSeg[] = []

  let minTs = Number.POSITIVE_INFINITY
  let maxTs = 0
  let newestNodeId: string | null = null
  let newestTs = -1

  const taskY = sessions.length > 0 ? ((sessions.length - 1) * ROW_H) / 2 : 0

  nodes.push({
    id: 'task',
    type: 'taskNode',
    position: { x: COL_TASK_X, y: taskY },
    data: { kind: 'task', title: taskTitle, status: taskStatus },
    draggable: false,
  })
  details.set('task', {
    type: 'task',
    title: taskTitle,
    status: taskStatus,
    sessionCount: sessions.length,
  })

  sessions.forEach((sess, si) => {
    const events = eventsMap[sess.id] ?? []
    const rowY = si * ROW_H
    const sStatus = deriveSessionStatus(events, storeStatus[sess.id], sess.ended_at)
    const running = sStatus === 'running'

    let errorText: string | undefined
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'error') {
        const p = parse(events[i])
        errorText = truncate(String(p.message ?? '未知错误'), 120)
        break
      }
    }

    const sessionNodeId = `s:${sess.id}`

    let stepIdx = 0
    let lastNodeId = sessionNodeId
    for (const ev of events) {
      if (ev.ts < minTs) minTs = ev.ts
      if (ev.ts > maxTs) maxTs = ev.ts

      let stepKind: StepKind | null = null
      if (ev.type === 'assistant_message') stepKind = 'reply'
      else if (ev.type === 'command_run') stepKind = 'command'
      else if (ev.type === 'file_edit') stepKind = 'file'
      if (!stepKind) continue

      const p = parse(ev)
      const nodeId = `st:${sess.id}:${stepIdx}`
      const x = STEP_X0 + stepIdx * STEP_DX

      let stepStatus: NodeStatus = 'done'
      const data: Record<string, unknown> = { kind: 'step', stepKind }

      if (stepKind === 'reply') {
        const full = String(p.text ?? '')
        data.text = truncate(full, 140)
        details.set(nodeId, { type: 'step', stepKind, status: 'done', ts: ev.ts, text: full })
      } else if (stepKind === 'command') {
        const cmd = String(p.cmd ?? '')
        const exitCode = num(p.exit_code)
        if (exitCode !== 0) stepStatus = 'failed'
        data.cmd = truncate(cmd, 80)
        data.exitCode = exitCode
        details.set(nodeId, {
          type: 'step',
          stepKind,
          status: stepStatus,
          ts: ev.ts,
          cmd,
          exitCode,
          outputTail: String(p.output_tail ?? ''),
        })
      } else {
        const path = String(p.path ?? '')
        const added = num(p.added)
        const removed = num(p.removed)
        const changeKind = String(p.kind ?? 'update')
        data.path = path
        data.added = added
        data.removed = removed
        data.changeKind = changeKind
        details.set(nodeId, {
          type: 'step',
          stepKind,
          status: 'done',
          ts: ev.ts,
          path,
          diff: (p.diff as string | undefined) ?? null,
          added,
          removed,
          changeKind,
        })
      }
      data.status = stepStatus

      nodes.push({
        id: nodeId,
        type: 'stepNode',
        position: { x, y: rowY },
        data,
        draggable: false,
      })
      edges.push({
        id: `e:${lastNodeId}->${nodeId}`,
        source: lastNodeId,
        target: nodeId,
        animated: running,
      })

      timeline.push({
        nodeId,
        stepKind,
        status: stepStatus,
        ts: ev.ts,
        label: stepLabel(stepKind, data),
      })

      if (ev.ts >= newestTs) {
        newestTs = ev.ts
        newestNodeId = nodeId
      }

      lastNodeId = nodeId
      stepIdx += 1
    }

    nodes.push({
      id: sessionNodeId,
      type: 'sessionNode',
      position: { x: COL_SESSION_X, y: rowY },
      data: {
        kind: 'session',
        engine: sess.engine,
        threadId: sess.thread_id,
        status: sStatus,
        index: si,
        stepCount: stepIdx,
        errorText,
      },
      draggable: false,
    })
    details.set(sessionNodeId, {
      type: 'session',
      engine: sess.engine,
      threadId: sess.thread_id,
      status: sStatus,
      startedAt: sess.started_at,
      endedAt: sess.ended_at,
      stepCount: stepIdx,
      errorText,
    })
    edges.push({
      id: `e:task->${sessionNodeId}`,
      source: 'task',
      target: sessionNodeId,
      animated: running,
    })
  })

  timeline.sort((a, b) => a.ts - b.ts)
  const totalMs = maxTs > 0 && minTs !== Number.POSITIVE_INFINITY ? maxTs - minTs : 0

  return { nodes, edges, details, timeline, totalMs, newestNodeId }
}
