import { create } from 'zustand'
import { WsManager, WsState } from '../lib/ws'
import { useAuthStore } from './authStore'

// ── Domain types ─────────────────────────────────────────────────────────────

export interface Task {
  id: string
  title: string
  status: 'todo' | 'dispatched' | 'done' | 'error'
  workdir: string
  created_at: number
  updated_at: number
  session_count: number
  file_count: number
  last_session_id?: string
}

export interface Session {
  id: string
  task_id: string
  engine: string
  thread_id?: string
  started_at: number
  ended_at?: number
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
  session_id?: string
  task_id?: string
  summary?: string
  cmd?: string
  exit_code?: number
  path?: string
  kind?: string
  added?: number
  removed?: number
  message?: string
  timestamp: string
  raw?: unknown
}

export interface FileEntry {
  name: string
  rel_path: string
  is_dir: boolean
  size: number
  ext: string
}

export interface FileContent {
  path: string
  root: string
  content: string
  encoding: string
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

  // File browsing
  fileRoot: string
  fileEntries: FileEntry[]
  fileContent: FileContent | null
  fileBrowsing: boolean

  _ws: WsManager | null

  init: () => void
  destroy: () => void
  clearEvents: () => void
  sendCommand: (command: string, data: unknown) => void
  createTask: (title: string) => void
  dispatchTask: (taskId: string) => void
  acceptTask: (taskId: string) => void
  sendChatMessage: (sessionId: string, message: string) => void
  listFiles: (path?: string) => void
  readFile: (path: string) => void
}

export const useSyncStore = create<SyncState>((set, get) => ({
  wsState: 'disconnected',
  tasks: [],
  sessions: [],
  chatSessions: [],
  chatMessages: [],
  events: [],
  unreadCount: 0,
  fileRoot: '',
  fileEntries: [],
  fileContent: null,
  fileBrowsing: false,
  _ws: null,

  init() {
    const existing = get()._ws
    if (existing) existing.close()

    const auth = useAuthStore.getState()
    if (!auth.accessToken) return

    // Generate local device ID if server registration failed
    let deviceId = auth.deviceId
    if (!deviceId) {
      deviceId = localStorage.getItem('iris.remote.device_id_fallback')
      if (!deviceId) {
        deviceId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        localStorage.setItem('iris.remote.device_id_fallback', deviceId)
      }
    }

    const ws = new WsManager(auth.accessToken, deviceId, {
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

  listFiles(path) {
    set({ fileBrowsing: true })
    get().sendCommand('list_files', { path: path ?? '' })
  },

  readFile(path) {
    set({ fileContent: null })
    get().sendCommand('read_file', { path })
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
    case 'files': {
      const d = data as { root?: string; entries?: FileEntry[] } | null
      if (d) {
        useSyncStore.setState({
          fileRoot: d.root ?? '',
          fileEntries: d.entries ?? [],
          fileBrowsing: false,
        })
      }
      break
    }
    case 'file_content': {
      const d = data as FileContent | null
      if (d) useSyncStore.setState({ fileContent: d })
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
    session_id: raw?.session_id as string | undefined,
    task_id: raw?.task_id as string | undefined,
    summary: raw?.summary as string | undefined,
    cmd: raw?.cmd as string | undefined,
    exit_code: raw?.exit_code as number | undefined,
    path: raw?.path as string | undefined,
    kind: raw?.kind as string | undefined,
    added: raw?.added as number | undefined,
    removed: raw?.removed as number | undefined,
    message: raw?.message as string | undefined,
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
