// Pure builder: turn task sessions + persisted events into a flat, ordered
// execution flow (sessions -> steps). No layout library, no graph — just a
// lightweight vertical stream model consumed by the Canvas page.

import type {
  CanvasEventRow,
  CanvasSessionRow,
  FlowSession,
  FlowStep,
  NodeStatus,
  StepKind,
} from './types'

function parse(row: CanvasEventRow): Record<string, unknown> {
  try {
    return JSON.parse(row.payload_json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
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

export interface BuildFlowInput {
  sessions: CanvasSessionRow[]
  eventsMap: Record<string, CanvasEventRow[]>
  /** sessionId -> live status from agentStore. */
  storeStatus: Record<string, string | undefined>
}

/** Build the ordered flow: sessions in start order, each with its steps. */
export function buildFlow(input: BuildFlowInput): FlowSession[] {
  const { sessions, eventsMap, storeStatus } = input

  return sessions.map((sess, si) => {
    const events = eventsMap[sess.id] ?? []
    const sStatus = deriveSessionStatus(events, storeStatus[sess.id], sess.ended_at)

    let errorText: string | undefined
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'error') {
        const p = parse(events[i])
        errorText = truncate(String(p.message ?? '未知错误'), 200)
        break
      }
    }

    const steps: FlowStep[] = []
    let stepIdx = 0
    for (const ev of events) {
      let stepKind: StepKind | null = null
      if (ev.type === 'assistant_message') stepKind = 'reply'
      else if (ev.type === 'command_run') stepKind = 'command'
      else if (ev.type === 'file_edit') stepKind = 'file'
      if (!stepKind) continue

      const p = parse(ev)
      const id = `st:${sess.id}:${stepIdx}`

      if (stepKind === 'reply') {
        steps.push({
          id,
          stepKind,
          status: 'done',
          ts: ev.ts,
          text: String(p.text ?? ''),
        })
      } else if (stepKind === 'command') {
        const exitCode = num(p.exit_code)
        steps.push({
          id,
          stepKind,
          status: exitCode !== 0 ? 'failed' : 'done',
          ts: ev.ts,
          cmd: String(p.cmd ?? ''),
          exitCode,
          outputTail: String(p.output_tail ?? ''),
        })
      } else {
        steps.push({
          id,
          stepKind,
          status: 'done',
          ts: ev.ts,
          path: String(p.path ?? ''),
          diff: (p.diff as string | undefined) ?? null,
          added: num(p.added),
          removed: num(p.removed),
          changeKind: String(p.kind ?? 'update'),
        })
      }
      stepIdx += 1
    }

    return {
      id: sess.id,
      engine: sess.engine,
      threadId: sess.thread_id,
      status: sStatus,
      index: si,
      startedAt: sess.started_at,
      endedAt: sess.ended_at,
      stepCount: stepIdx,
      errorText,
      steps,
    }
  })
}
