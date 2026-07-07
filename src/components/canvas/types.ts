// Shared types for the lightweight execution-flow view (v0.5 F4c).
// The heavy React-Flow node graph was retired; the canvas is now a simple
// vertical execution stream, so only the raw DB rows + a flat flow model remain.

/** Mirrors Rust's CanvasSessionRow. */
export interface CanvasSessionRow {
  id: string
  engine: string
  thread_id: string | null
  started_at: number
  ended_at: number | null
}

/** Mirrors Rust's CanvasEventRow (raw persisted event). */
export interface CanvasEventRow {
  type: string
  ts: number
  payload_json: string
}

/** Step / session lifecycle state, drives status coloring. */
export type NodeStatus = 'running' | 'done' | 'failed'

/** The three step kinds rendered in the flow. */
export type StepKind = 'reply' | 'command' | 'file'

/** A single execution step (summary + full detail merged; expanded inline). */
export interface FlowStep {
  id: string
  stepKind: StepKind
  status: NodeStatus
  ts: number
  // reply
  text?: string
  // command
  cmd?: string
  exitCode?: number
  outputTail?: string
  // file
  path?: string
  diff?: string | null
  added?: number
  removed?: number
  changeKind?: string
}

/** One session with its ordered steps. */
export interface FlowSession {
  id: string
  engine: string
  threadId: string | null
  status: NodeStatus
  index: number
  startedAt: number
  endedAt: number | null
  stepCount: number
  errorText?: string
  steps: FlowStep[]
}
