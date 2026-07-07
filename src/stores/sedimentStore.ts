import { create } from 'zustand'
import type { WorkbenchEntry } from './workbenchStore'
import type { CanvasEventRow, CanvasSessionRow } from '../components/canvas/types'

// ── Tauri helper ───────────────────────────────────────────────────────────────

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

// ── Types (mirror Rust sediment.rs) ─────────────────────────────────────────────

export type RunKind = 'board' | 'workbench'

/** Mirrors Rust `RunSummary`. Optional fields are `skip_serializing_if None`. */
export interface RunSummary {
  id: string
  kind: RunKind
  title: string
  cwd: string
  model?: string
  total_tokens?: number
  files_changed: number
  duration_ms?: number
  status: string
  created_at: number
}

/** Mirrors Rust `SkillInfo`. */
export interface SkillInfo {
  name: string
  description: string
  source: string
  path: string
}

/** Mirrors Rust `ReuseInfo`. */
export interface ReuseInfo {
  cwd: string
  model: string
  first_prompt: string
}

/** Mirrors Rust `WorkbenchEntryRow`. */
export interface WorkbenchEntryRow {
  kind: string
  payload_json: string
  ts: number
}

/** One session's raw events, mirrors Rust `SessionEvents`. */
export interface SessionEvents {
  session_id: string
  events: CanvasEventRow[]
}

/** Mirrors Rust `RunDetail` (serde tag = "kind"). */
export type RunDetail =
  | { kind: 'workbench'; entries: WorkbenchEntryRow[] }
  | { kind: 'board'; sessions: CanvasSessionRow[]; events: SessionEvents[] }

export type FilterKind = 'all' | RunKind

// ── Read-only replay: persisted workbench rows -> renderable entries ────────────

function parse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Rebuild the workbench output stream from persisted entry rows for read-only
 * replay. Deltas/thinking/tool_started/token_stats are not persisted (see
 * pi_engine.rs `persist()`), so replay shows finalized messages + tool cards.
 */
export function rebuildEntries(rows: WorkbenchEntryRow[]): WorkbenchEntry[] {
  const out: WorkbenchEntry[] = []
  rows.forEach((row, i) => {
    const id = `replay-${i}`
    const p = parse(row.payload_json)
    switch (row.kind) {
      case 'user':
        out.push({ id, kind: 'user', text: str(p.text) })
        break
      case 'assistant_message':
        out.push({ id, kind: 'assistant', text: str(p.text), streaming: false })
        break
      case 'tool_bash':
        out.push({
          id,
          kind: 'tool_bash',
          toolCallId: str(p.tool_call_id),
          cmd: str(p.cmd),
          output: str(p.output),
          exitCode:
            typeof p.exit_code === 'number' ? (p.exit_code as number) : null,
        })
        break
      case 'tool_edit':
        out.push({
          id,
          kind: 'tool_edit',
          toolCallId: str(p.tool_call_id),
          path: str(p.path),
          diff: str(p.diff),
        })
        break
      case 'tool_write':
        out.push({
          id,
          kind: 'tool_write',
          toolCallId: str(p.tool_call_id),
          path: str(p.path),
        })
        break
      case 'tool_result':
        out.push({
          id,
          kind: 'tool_result',
          toolCallId: str(p.tool_call_id),
          tool: str(p.tool),
          output: str(p.output),
          isError: p.is_error === true,
        })
        break
      case 'error':
        out.push({ id, kind: 'error', text: str(p.message) })
        break
      default:
        // turn_started / turn_completed and anything else: not rendered.
        break
    }
  })
  return out
}

/** Turn a board RunDetail's session events into the eventsMap buildFlow wants. */
export function boardEventsMap(
  events: SessionEvents[],
): Record<string, CanvasEventRow[]> {
  const map: Record<string, CanvasEventRow[]> = {}
  for (const se of events) map[se.session_id] = se.events
  return map
}

// ── Store ───────────────────────────────────────────────────────────────────────

interface SedimentStore {
  runs: RunSummary[]
  runsLoading: boolean
  runsError: string | null
  filterKind: FilterKind
  query: string

  skills: SkillInfo[]
  skillsLoaded: boolean
  skillsLoading: boolean
  skillsError: string | null

  setFilterKind: (k: FilterKind) => void
  setQuery: (q: string) => void
  loadRuns: () => Promise<void>
  loadSkills: () => Promise<void>
  loadDetail: (kind: RunKind, id: string) => Promise<RunDetail>
  reuse: (kind: RunKind, id: string) => Promise<ReuseInfo>
  deleteRun: (kind: RunKind, id: string) => Promise<void>
}

export const useSedimentStore = create<SedimentStore>((set, get) => ({
  runs: [],
  runsLoading: false,
  runsError: null,
  filterKind: 'all',
  query: '',

  skills: [],
  skillsLoaded: false,
  skillsLoading: false,
  skillsError: null,

  setFilterKind: (k) => {
    set({ filterKind: k })
    void get().loadRuns()
  },

  setQuery: (q) => set({ query: q }),

  loadRuns: async () => {
    if (!isTauri) {
      set({ runsLoading: false, runsError: null, runs: [] })
      return
    }
    set({ runsLoading: true, runsError: null })
    try {
      const { filterKind, query } = get()
      const runs = await tauriInvoke<RunSummary[]>('sediment_runs', {
        kind: filterKind === 'all' ? null : filterKind,
        query: query.trim() || null,
        limit: 300,
        offset: 0,
      })
      set({ runs, runsLoading: false })
    } catch (e) {
      set({ runsLoading: false, runsError: `运行历史加载失败：${String(e)}` })
    }
  },

  loadSkills: async () => {
    if (!isTauri) {
      set({ skillsLoaded: true, skillsLoading: false, skills: [] })
      return
    }
    set({ skillsLoading: true, skillsError: null })
    try {
      const skills = await tauriInvoke<SkillInfo[]>('sediment_skills')
      set({ skills, skillsLoaded: true, skillsLoading: false })
    } catch (e) {
      set({
        skillsLoaded: true,
        skillsLoading: false,
        skillsError: `技能扫描失败：${String(e)}`,
      })
    }
  },

  loadDetail: async (kind, id) => {
    return tauriInvoke<RunDetail>('sediment_run_detail', { kind, id })
  },

  reuse: async (kind, id) => {
    return tauriInvoke<ReuseInfo>('sediment_reuse', { kind, id })
  },

  deleteRun: async (kind, id) => {
    await tauriInvoke<void>('sediment_delete', { kind, id })
    set((s) => ({ runs: s.runs.filter((r) => !(r.kind === kind && r.id === id)) }))
  },
}))
