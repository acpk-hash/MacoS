import { create } from 'zustand'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'running' | 'done' | 'error'

/** Status of a file edit in the diff panel. */
export type FileEditStatus = 'pending' | 'approved' | 'reverted'

/** Per-file aggregated state kept in the diff panel sidebar. */
export interface FileEditInfo {
  path: string
  /** Last edit kind reported by codex (create / update / delete). */
  kind: string
  /** Unified diff text (null when unavailable). */
  diff: string | null
  /** Lines added (from diff statistics). */
  added: number
  /** Lines removed (from diff statistics). */
  removed: number
  /** User's approval / revert decision. */
  status: FileEditStatus
}

export type TimelineEntry =
  | { kind: 'user_message'; text: string }
  | { kind: 'assistant_message'; text: string }
  | {
      kind: 'file_edit'
      path: string
      editKind: string
      diff: string | null
      added: number
      removed: number
    }
  | {
      kind: 'command_run'
      cmd: string
      exitCode: number
      outputTail: string
      expanded: boolean
    }
  | {
      kind: 'usage'
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
      reasoningOutputTokens: number
    }
  | { kind: 'error'; message: string }

export interface Session {
  sessionId: string
  status: SessionStatus
  threadId?: string
  entries: TimelineEntry[]
  /** Aggregated file-change info keyed by path (for the diff panel). */
  fileEdits: Map<string, FileEditInfo>
}

// ── Raw AgentEvent shape from Tauri (mirrors Rust serde output) ───────────────

interface RawAgentEvent {
  type: string
  // session_started
  session_id?: string
  thread_id?: string
  // assistant_message / reasoning / error
  text?: string
  message?: string
  // file_edit
  path?: string
  kind?: string
  diff?: string
  added?: number
  removed?: number
  // command_run
  cmd?: string
  exit_code?: number
  output_tail?: string
  // usage
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  // tool_call
  name?: string
  detail?: string
}

// ── Store interface ───────────────────────────────────────────────────────────

interface AgentStore {
  sessions: Record<string, Session>
  activeSessionId: string | null

  createSession: (sessionId: string) => void
  setActiveSession: (sessionId: string | null) => void
  addUserMessage: (sessionId: string, text: string) => void
  markSessionRunning: (sessionId: string) => void
  dispatchAgentEvent: (sessionId: string, event: RawAgentEvent) => void
  toggleCommandExpanded: (sessionId: string, entryIndex: number) => void
  /** Update the approval/revert status of a file (frontend-side state). */
  setFileEditStatus: (
    sessionId: string,
    path: string,
    status: FileEditStatus,
  ) => void
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAgentStore = create<AgentStore>((set) => ({
  sessions: {},
  activeSessionId: null,

  createSession: (sessionId) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          sessionId,
          status: 'running',
          entries: [],
          fileEdits: new Map(),
        },
      },
      activeSessionId: sessionId,
    }))
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId })
  },

  addUserMessage: (sessionId, text) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            entries: [...session.entries, { kind: 'user_message' as const, text }],
          },
        },
      }
    })
  },

  markSessionRunning: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, status: 'running' as const },
        },
      }
    })
  },

  dispatchAgentEvent: (sessionId, event) => {
    set((state) => {
      // Create the session on-the-fly if it doesn't exist yet (race: events
      // can arrive before createSession is called from the invoke callback).
      const existing = state.sessions[sessionId] ?? {
        sessionId,
        status: 'running' as SessionStatus,
        entries: [] as TimelineEntry[],
        fileEdits: new Map<string, FileEditInfo>(),
      }

      let newEntries: TimelineEntry[] = [...existing.entries]
      let newStatus: SessionStatus = existing.status
      let newThreadId: string | undefined = existing.threadId
      // Clone the fileEdits map so we don't mutate the old reference.
      const newFileEdits = new Map(existing.fileEdits)

      switch (event.type) {
        case 'session_started':
          newThreadId = event.thread_id
          newStatus = 'running'
          break

        case 'assistant_message':
          if (event.text != null) {
            newEntries.push({ kind: 'assistant_message', text: event.text })
          }
          break

        case 'file_edit':
          if (event.path != null) {
            const path = event.path
            const added = event.added ?? 0
            const removed = event.removed ?? 0
            const diff = event.diff ?? null
            const editKind = event.kind ?? 'update'

            newEntries.push({
              kind: 'file_edit',
              path,
              editKind,
              diff,
              added,
              removed,
            })

            // Update (or create) the per-file aggregated entry.
            // Preserve existing status if the user has already reviewed it.
            const existingInfo = newFileEdits.get(path)
            newFileEdits.set(path, {
              path,
              kind: editKind,
              diff,
              added,
              removed,
              status: existingInfo?.status ?? 'pending',
            })
          }
          break

        case 'command_run':
          if (event.cmd != null) {
            newEntries.push({
              kind: 'command_run',
              cmd: event.cmd,
              exitCode: event.exit_code ?? -1,
              outputTail: event.output_tail ?? '',
              expanded: false,
            })
          }
          break

        case 'usage':
          newEntries.push({
            kind: 'usage',
            inputTokens: event.input_tokens ?? 0,
            cachedInputTokens: event.cached_input_tokens ?? 0,
            outputTokens: event.output_tokens ?? 0,
            reasoningOutputTokens: event.reasoning_output_tokens ?? 0,
          })
          break

        case 'turn_completed':
          newStatus = 'done'
          break

        case 'error':
          if (event.message) {
            newEntries.push({ kind: 'error', message: event.message })
          }
          newStatus = 'error'
          break

        // tool_call and others: silently ignore for now
        default:
          break
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            status: newStatus,
            threadId: newThreadId,
            entries: newEntries,
            fileEdits: newFileEdits,
          },
        },
      }
    })
  },

  toggleCommandExpanded: (sessionId, entryIndex) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      const entries = session.entries.map((e, i) => {
        if (i === entryIndex && e.kind === 'command_run') {
          return { ...e, expanded: !e.expanded }
        }
        return e
      })
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, entries },
        },
      }
    })
  },

  setFileEditStatus: (sessionId, path, status) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      const newFileEdits = new Map(session.fileEdits)
      const info = newFileEdits.get(path)
      if (info) {
        newFileEdits.set(path, { ...info, status })
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, fileEdits: newFileEdits },
        },
      }
    })
  },
}))

// ── Tauri event listener (registered once at startup) ─────────────────────────

type UnlistenFn = () => void
let _unlisten: UnlistenFn | null = null

export async function initAgentEventListener(): Promise<void> {
  if (_unlisten) return // already registered

  // Guard: only run inside the Tauri desktop shell
  if (
    typeof window === 'undefined' ||
    !(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  ) {
    return
  }

  try {
    const { listen } = await import('@tauri-apps/api/event')
    _unlisten = await listen<{ session_id: string; event: RawAgentEvent }>(
      'agent-event',
      (tauriEvent) => {
        const { session_id, event } = tauriEvent.payload
        useAgentStore.getState().dispatchAgentEvent(session_id, event)
      },
    )
  } catch (err) {
    console.warn('[agentStore] failed to register agent-event listener:', err)
  }
}
