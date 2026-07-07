// Shared types for the workflow execution canvas (v0.3 T4).

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

/** Node lifecycle state, drives the visual language (glow / green / red). */
export type NodeStatus = 'running' | 'done' | 'failed'

/** The three step kinds rendered as StepNode. */
export type StepKind = 'reply' | 'command' | 'file'

// ── Node data payloads (kept to summaries; full detail lives in a ref map) ─────

export interface TaskNodeData {
  kind: 'task'
  title: string
  /** Raw task status string from the DB (running / awaiting_review / done …). */
  status: string
  [key: string]: unknown
}

export interface SessionNodeData {
  kind: 'session'
  engine: string
  threadId: string | null
  status: NodeStatus
  index: number
  stepCount: number
  /** Short error summary when the session failed. */
  errorText?: string
  [key: string]: unknown
}

export interface StepNodeData {
  kind: 'step'
  stepKind: StepKind
  status: NodeStatus
  /** reply: truncated text. */
  text?: string
  /** command: the command line. */
  cmd?: string
  exitCode?: number
  /** file: path + line deltas. */
  path?: string
  added?: number
  removed?: number
  changeKind?: string
  [key: string]: unknown
}

// ── Detail entries (lazy-loaded into the drawer on node click) ─────────────────

export type DetailEntry =
  | { type: 'task'; title: string; status: string; sessionCount: number }
  | {
      type: 'session'
      engine: string
      threadId: string | null
      status: NodeStatus
      startedAt: number
      endedAt: number | null
      stepCount: number
      errorText?: string
    }
  | {
      type: 'step'
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

/** A colored segment in the bottom timeline bar (one per step, ts order). */
export interface TimelineSeg {
  nodeId: string
  stepKind: StepKind
  status: NodeStatus
  ts: number
  label: string
}
