import { create } from 'zustand'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'running' | 'done' | 'error'

export type TimelineEntry =
  | { kind: 'user_message'; text: string }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'file_edit'; path: string; editKind: string }
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
      }

      let newEntries: TimelineEntry[] = [...existing.entries]
      let newStatus: SessionStatus = existing.status
      let newThreadId: string | undefined = existing.threadId

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
            newEntries.push({
              kind: 'file_edit',
              path: event.path,
              editKind: event.kind ?? 'update',
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
