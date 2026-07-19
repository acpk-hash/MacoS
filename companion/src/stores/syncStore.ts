import { create } from 'zustand'
import { WsManager, WsState } from '../lib/ws'
import { useAuthStore } from './authStore'

// ── Domain types ─────────────────────────────────────────────────────────────

export interface Task {
  id: string
  title: string
  status: 'todo' | 'dispatched' | 'done' | 'error'
  created_at: string
  updated_at?: string
}

export interface Session {
  id: string
  title: string
  model?: string
  created_at: string
}

export interface ChatSession {
  id: string
  title: string
  model?: string
  last_message?: string
  last_message_at?: string
}

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

export interface AgentEvent {
  id: string
  type: string
  summary?: string
  cmd?: string
  exit_code?: number
  path?: string
  added?: number
  removed?: number
  timestamp: string
  raw?: unknown
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface SyncState {
  wsState: WsState
  tasks: Task[]
  sessions: Session[]
  chatSessions: ChatSession[]
  chatMessages: ChatMessage[]
  events: AgentEvent[]
  unreadCount: number

  _ws: WsManager | null

  init: () => void
  destroy: () => void
  clearEvents: () => void
  sendCommand: (command: string, data: unknown) => void
  createTask: (title: string) => void
  dispatchTask: (taskId: string) => void
  acceptTask: (taskId: string) => void
  sendChatMessage: (sessionId: string, message: string) => void
}

export const useSyncStore = create<SyncState>((set, get) => ({
  wsState: 'disconnected',
  tasks: [],
  sessions: [],
  chatSessions: [],
  chatMessages: [],
  events: [],
  unreadCount: 0,
  _ws: null,

  init() {
    const existing = get()._ws
    if (existing) existing.close()

    const auth = useAuthStore.getState()
    if (!auth.accessToken || !auth.deviceId) return

    const ws = new WsManager(auth.accessToken, auth.deviceId, {
      onStateChange(state) {
        set({ wsState: state })
      },
      onSnapshot(kind, data) {
        handleSnapshot(kind, data)
      },
      onEvent(type, data) {
        handleEvent(type, data)
      },
    })

    set({ _ws: ws })
    ws.connect()
  },

  destroy() {
    get()._ws?.close()
    set({ _ws: null, wsState: 'disconnected' })
  },

  clearEvents() {
    set({ events: [], unreadCount: 0 })
  },

  sendCommand(command, data) {
    get()._ws?.sendCommand(command, data)
  },

  createTask(title) {
    get().sendCommand('create_task', { title })
  },

  dispatchTask(taskId) {
    get().sendCommand('dispatch_task', { task_id: taskId })
  },

  acceptTask(taskId) {
    get().sendCommand('accept_task', { task_id: taskId })
  },

  sendChatMessage(sessionId, message) {
    get().sendCommand('chat_prompt', { session_id: sessionId, message })
  },
}))

// ── Snapshot handler ──────────────────────────────────────────────────────────

function handleSnapshot(kind: string, data: unknown): void {
  switch (kind) {
    case 'tasks':
      useSyncStore.setState({ tasks: asArray<Task>(data) })
      break
    case 'sessions':
      useSyncStore.setState({ sessions: asArray<Session>(data) })
      break
    case 'chat': {
      const chat = data as { sessions?: ChatSession[]; messages?: ChatMessage[] } | null
      if (chat) {
        useSyncStore.setState({
          ...(chat.sessions ? { chatSessions: chat.sessions } : {}),
          ...(chat.messages ? { chatMessages: chat.messages } : {}),
        })
      }
      break
    }
    default:
      break
  }
}

// ── Event handler ─────────────────────────────────────────────────────────────

let _eventSeq = 0

function handleEvent(type: string, data: unknown): void {
  const raw = data as Record<string, unknown> | null | undefined
  const event: AgentEvent = {
    id: `ev-${Date.now()}-${_eventSeq++}`,
    type,
    timestamp: (raw?.timestamp as string | undefined) ?? new Date().toISOString(),
    summary: raw?.summary as string | undefined,
    cmd: raw?.cmd as string | undefined,
    exit_code: raw?.exit_code as number | undefined,
    path: raw?.path as string | undefined,
    added: raw?.added as number | undefined,
    removed: raw?.removed as number | undefined,
    raw: data,
  }

  useSyncStore.setState((s) => ({
    events: [event, ...s.events].slice(0, 500),
    unreadCount: s.unreadCount + 1,
  }))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}
