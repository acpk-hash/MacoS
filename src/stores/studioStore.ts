import { create } from 'zustand'

// ── Row types (mirror Rust src-tauri/src/db/studio.rs) ────────────────────────

export interface ChatSessionRow {
  id: string
  title: string
  model: string
  created_at: number
  updated_at: number
}

export interface ChatMessageRow {
  id: string
  session_id: string
  role: string
  content: string
  attachments_json: string | null
  model: string | null
  /** complete | streaming | stopped | error */
  status: string
  created_at: number
}

/** A generated media record (image or video). Mirrors GenMediaRow in Rust. */
export interface GenMediaRow {
  id: string
  /** "image" | "video" */
  kind: string
  prompt: string
  model: string
  params_json: string | null
  local_path: string | null
  source_url: string | null
  /** pending | running | done | failed */
  status: string
  error: string | null
  created_at: number
}

/** Runtime capability probe result (mirrors Rust Capabilities). */
export interface Capabilities {
  video: boolean
}

/** A composer attachment sent to `chat_send`. */
export interface Attachment {
  /** "image" | "text" */
  kind: 'image' | 'text'
  name?: string
  /** For images: a `data:image/...;base64,...` URL. */
  data_url?: string
  /** For text files: the inlined content. */
  text?: string
}

// ── Raw studio-event payloads (mirror Rust serde output) ──────────────────────

interface StudioEvent {
  type: string
  session_id?: string
  message_id?: string
  text?: string
  status?: string
  message?: string
  // media events
  id?: string
  kind?: string
  local_path?: string | null
  source_url?: string | null
  error?: string
}

// ── Tauri environment guard ───────────────────────────────────────────────────

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

// ── Store interface ───────────────────────────────────────────────────────────

interface StudioStore {
  /** Session list, ordered by updated_at DESC (from backend). */
  sessions: ChatSessionRow[]
  activeSessionId: string | null
  /** Messages of the active session (streaming text is applied in-place). */
  messages: ChatMessageRow[]
  /** Relay model ids (cached backend-side for 5 min). */
  models: string[]
  modelsLoaded: boolean
  /** Currently selected model (session-level memory). */
  currentModel: string
  /** Per-session model override, remembered when switching sessions. */
  sessionModel: Record<string, string>
  /** Sessions with an in-flight stream (keyed by session id). */
  streaming: Record<string, boolean>
  /** Non-fatal error banner text (e.g. models load failure). */
  loadError: string | null

  // ── Media (generation studio) branch ──────────────────────────────────────
  /** Generated media for the currently loaded kind (newest first). */
  media: GenMediaRow[]
  mediaLoaded: boolean
  /** Runtime capabilities (video availability). Null until probed. */
  capabilities: Capabilities | null

  loadModels: () => Promise<void>
  loadSessions: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  newSession: () => void
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  setModel: (model: string) => void
  send: (content: string, attachments: Attachment[]) => Promise<void>
  regenerate: () => Promise<void>
  stop: () => Promise<void>

  loadCapabilities: () => Promise<void>
  loadMedia: (kind: 'image' | 'video') => Promise<void>
  generateImage: (
    prompt: string,
    model: string,
    size: string,
    n: number,
  ) => Promise<void>
  deleteMedia: (id: string) => Promise<void>

  // Internal event appliers (invoked by the global studio-event listener).
  _applyDelta: (sessionId: string, messageId: string, text: string) => void
  _applyDone: (
    sessionId: string,
    messageId: string,
    status: string,
    text: string,
  ) => void
  _applyError: (sessionId: string, messageId: string, message: string) => void
  _applyMediaRunning: (id: string) => void
  _applyMediaDone: (
    id: string,
    localPath: string | null,
    sourceUrl: string | null,
  ) => void
  _applyMediaFailed: (id: string, error: string) => void
}

// ── Streaming delta coalescing (rAF-batched for render perf) ──────────────────

const pendingDeltas = new Map<string, string>()
let rafHandle: number | null = null

function flushDeltas() {
  rafHandle = null
  const store = useStudioStore.getState()
  const activeId = store.activeSessionId
  for (const [messageId, text] of pendingDeltas) {
    if (activeId) store._applyDelta(activeId, messageId, text)
  }
  pendingDeltas.clear()
}

function bufferDelta(messageId: string, text: string) {
  pendingDeltas.set(messageId, (pendingDeltas.get(messageId) ?? '') + text)
  if (rafHandle == null) {
    rafHandle =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flushDeltas)
        : (setTimeout(flushDeltas, 16) as unknown as number)
  }
}

function flushNow() {
  if (rafHandle != null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle)
    else clearTimeout(rafHandle)
    rafHandle = null
  }
  flushDeltas()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'pending-' + Math.random().toString(36).slice(2)
}

/** Params captured before an image_generate call so `media_running` events
 *  (which only carry an id) can render an informative placeholder card. */
let pendingGen: { prompt: string; model: string; size: string } | null = null

// ── Store ─────────────────────────────────────────────────────────────────────

export const useStudioStore = create<StudioStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  models: [],
  modelsLoaded: false,
  currentModel: '',
  sessionModel: {},
  streaming: {},
  loadError: null,
  media: [],
  mediaLoaded: false,
  capabilities: null,

  loadModels: async () => {
    if (!isTauri) return
    try {
      const models = await tauriInvoke<string[]>('studio_models')
      set((s) => ({
        models,
        modelsLoaded: true,
        loadError: null,
        currentModel: s.currentModel || models[0] || '',
      }))
    } catch (e) {
      set({ modelsLoaded: true, loadError: `模型列表加载失败：${String(e)}` })
    }
  },

  loadSessions: async () => {
    if (!isTauri) return
    try {
      const sessions = await tauriInvoke<ChatSessionRow[]>('chat_sessions_list')
      set({ sessions })
    } catch (e) {
      console.warn('[studioStore] loadSessions failed:', e)
    }
  },

  selectSession: async (id) => {
    if (!isTauri) return
    set({ activeSessionId: id, messages: [] })
    try {
      const messages = await tauriInvoke<ChatMessageRow[]>('chat_messages_list', {
        sessionId: id,
      })
      // Guard against a race where the user switched again mid-load.
      if (get().activeSessionId !== id) return
      const session = get().sessions.find((x) => x.id === id)
      const remembered = get().sessionModel[id] ?? session?.model
      set((s) => ({
        messages,
        currentModel:
          remembered && s.models.includes(remembered)
            ? remembered
            : s.currentModel,
      }))
    } catch (e) {
      console.warn('[studioStore] selectSession failed:', e)
    }
  },

  newSession: () => {
    set({ activeSessionId: null, messages: [] })
  },

  renameSession: async (id, title) => {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      await tauriInvoke<void>('chat_sessions_rename', { sessionId: id, title: trimmed })
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === id ? { ...x, title: trimmed } : x,
        ),
      }))
    } catch (e) {
      console.warn('[studioStore] renameSession failed:', e)
    }
  },

  deleteSession: async (id) => {
    try {
      await tauriInvoke<void>('chat_sessions_delete', { sessionId: id })
    } catch (e) {
      console.warn('[studioStore] deleteSession failed:', e)
    }
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const clearing = s.activeSessionId === id
      return {
        sessions,
        activeSessionId: clearing ? null : s.activeSessionId,
        messages: clearing ? [] : s.messages,
      }
    })
  },

  setModel: (model) => {
    set((s) => ({
      currentModel: model,
      sessionModel: s.activeSessionId
        ? { ...s.sessionModel, [s.activeSessionId]: model }
        : s.sessionModel,
    }))
  },

  send: async (content, attachments) => {
    if (!isTauri) return
    const model = get().currentModel
    if (!model) {
      set({ loadError: '尚未选择模型' })
      return
    }

    // Ensure an active session exists (create lazily so the sidebar updates).
    let sessionId = get().activeSessionId
    if (!sessionId) {
      try {
        const row = await tauriInvoke<ChatSessionRow>('chat_sessions_create', {
          title: null,
          model,
        })
        sessionId = row.id
        set((s) => ({
          sessions: [row, ...s.sessions],
          activeSessionId: row.id,
          messages: [],
        }))
      } catch (e) {
        set({ loadError: `创建会话失败：${String(e)}` })
        return
      }
    }
    const sid = sessionId

    const now = Date.now()
    const userMsg: ChatMessageRow = {
      id: uuid(),
      session_id: sid,
      role: 'user',
      content,
      attachments_json: attachments.length ? JSON.stringify(attachments) : null,
      model,
      status: 'complete',
      created_at: now,
    }
    const placeholder: ChatMessageRow = {
      id: uuid(),
      session_id: sid,
      role: 'assistant',
      content: '',
      attachments_json: null,
      model,
      status: 'streaming',
      created_at: now + 1,
    }
    set((s) => ({
      messages: [...s.messages, userMsg, placeholder],
      streaming: { ...s.streaming, [sid]: true },
    }))

    try {
      await tauriInvoke<string>('chat_send', {
        sessionId: sid,
        userContent: content,
        attachments,
        model,
      })
    } catch (e) {
      // A hard failure before any event was emitted: surface it on the bubble.
      get()._applyError(sid, placeholder.id, String(e))
    }
    // Refresh titles / ordering (auto-title happens on the backend).
    get().loadSessions()
  },

  regenerate: async () => {
    const msgs = get().messages
    let lastUser: ChatMessageRow | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = msgs[i]
        break
      }
    }
    if (!lastUser) return
    const attachments: Attachment[] = lastUser.attachments_json
      ? (JSON.parse(lastUser.attachments_json) as Attachment[])
      : []
    await get().send(lastUser.content, attachments)
  },

  stop: async () => {
    const sid = get().activeSessionId
    if (!sid) return
    try {
      await tauriInvoke<void>('chat_stop', { sessionId: sid })
    } catch (e) {
      console.warn('[studioStore] stop failed:', e)
    }
  },

  // ── Media (generation) ─────────────────────────────────────────────────────

  loadCapabilities: async () => {
    if (!isTauri) return
    try {
      const caps = await tauriInvoke<Capabilities>('studio_capabilities')
      set({ capabilities: caps })
    } catch (e) {
      // Treat probe failure as "no video" (endpoint absent / offline).
      console.warn('[studioStore] loadCapabilities failed:', e)
      set({ capabilities: { video: false } })
    }
  },

  loadMedia: async (kind) => {
    if (!isTauri) return
    try {
      const media = await tauriInvoke<GenMediaRow[]>('media_list', { kind })
      set({ media, mediaLoaded: true })
    } catch (e) {
      console.warn('[studioStore] loadMedia failed:', e)
      set({ mediaLoaded: true })
    }
  },

  generateImage: async (prompt, model, size, n) => {
    if (!isTauri) return
    if (!prompt.trim() || !model) return
    pendingGen = { prompt, model, size }
    try {
      await tauriInvoke<string[]>('image_generate', { prompt, model, size, n })
    } catch (e) {
      set({ loadError: `图像生成失败：${String(e)}` })
    } finally {
      pendingGen = null
      // Reconcile optimistic rows with DB truth.
      await get().loadMedia('image')
    }
  },

  deleteMedia: async (id) => {
    try {
      await tauriInvoke<void>('media_delete', { id })
    } catch (e) {
      console.warn('[studioStore] deleteMedia failed:', e)
    }
    set((s) => ({ media: s.media.filter((m) => m.id !== id) }))
  },

  _applyDelta: (sessionId, messageId, text) => {
    if (sessionId !== get().activeSessionId) return
    set((s) => {
      const msgs = [...s.messages]
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx >= 0) {
        msgs[idx] = {
          ...msgs[idx],
          content: msgs[idx].content + text,
          status: 'streaming',
        }
      } else {
        // Adopt the trailing streaming placeholder (its temp id predates the
        // real message id returned by the backend).
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && last.status === 'streaming') {
          msgs[msgs.length - 1] = {
            ...last,
            id: messageId,
            content: last.content + text,
          }
        } else {
          msgs.push({
            id: messageId,
            session_id: sessionId,
            role: 'assistant',
            content: text,
            attachments_json: null,
            model: s.currentModel,
            status: 'streaming',
            created_at: Date.now(),
          })
        }
      }
      return { messages: msgs }
    })
  },

  _applyDone: (sessionId, messageId, status, text) => {
    set((s) => {
      const streaming = { ...s.streaming }
      delete streaming[sessionId]
      if (sessionId !== s.activeSessionId) return { streaming }
      let matched = false
      const msgs = s.messages.map((m) => {
        if (m.id === messageId) {
          matched = true
          return { ...m, content: text, status }
        }
        return m
      })
      // If the placeholder was never adopted, finalize the trailing one.
      if (!matched) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && msgs[i].status === 'streaming') {
            msgs[i] = { ...msgs[i], id: messageId, content: text, status }
            break
          }
        }
      }
      return { messages: msgs, streaming }
    })
    // Reorder the sidebar (updated_at bumped backend-side).
    get().loadSessions()
  },

  _applyError: (sessionId, messageId, message) => {
    set((s) => {
      const streaming = { ...s.streaming }
      delete streaming[sessionId]
      if (sessionId !== s.activeSessionId) return { streaming }
      let matched = false
      const msgs = s.messages.map((m) => {
        if (m.id === messageId) {
          matched = true
          return { ...m, content: message, status: 'error' }
        }
        return m
      })
      if (!matched) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && msgs[i].status === 'streaming') {
            msgs[i] = { ...msgs[i], id: messageId, content: message, status: 'error' }
            break
          }
        }
      }
      return { messages: msgs, streaming }
    })
  },

  _applyMediaRunning: (id) => {
    set((s) => {
      if (s.media.some((m) => m.id === id)) return {}
      const p = pendingGen
      const row: GenMediaRow = {
        id,
        kind: 'image',
        prompt: p?.prompt ?? '',
        model: p?.model ?? '',
        params_json: p ? JSON.stringify({ size: p.size }) : null,
        local_path: null,
        source_url: null,
        status: 'running',
        error: null,
        created_at: Date.now(),
      }
      return { media: [row, ...s.media] }
    })
  },

  _applyMediaDone: (id, localPath, sourceUrl) => {
    set((s) => ({
      media: s.media.map((m) =>
        m.id === id
          ? { ...m, status: 'done', local_path: localPath, source_url: sourceUrl }
          : m,
      ),
    }))
  },

  _applyMediaFailed: (id, error) => {
    set((s) => ({
      media: s.media.map((m) =>
        m.id === id ? { ...m, status: 'failed', error } : m,
      ),
    }))
  },
}))

// ── Global studio-event listener (registered once at startup) ─────────────────

let _unlisten: (() => void) | null = null

export async function initStudioEventListener(): Promise<void> {
  if (_unlisten || !isTauri) return
  try {
    const { listen } = await import('@tauri-apps/api/event')
    _unlisten = await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      const store = useStudioStore.getState()
      switch (p.type) {
        case 'delta':
          if (p.session_id && p.message_id) {
            if (p.session_id === store.activeSessionId) {
              bufferDelta(p.message_id, p.text ?? '')
            }
          }
          break
        case 'done':
          flushNow()
          if (p.session_id && p.message_id) {
            store._applyDone(
              p.session_id,
              p.message_id,
              p.status ?? 'complete',
              p.text ?? '',
            )
          }
          break
        case 'error':
          flushNow()
          if (p.session_id && p.message_id) {
            store._applyError(p.session_id, p.message_id, p.message ?? '出错')
          }
          break
        case 'media_running':
          if (p.id) store._applyMediaRunning(p.id)
          break
        case 'media_done':
          if (p.id) {
            store._applyMediaDone(p.id, p.local_path ?? null, p.source_url ?? null)
          }
          break
        case 'media_failed':
          if (p.id) store._applyMediaFailed(p.id, p.error ?? '生成失败')
          break
        default:
          break
      }
    })
  } catch (err) {
    console.warn('[studioStore] failed to register studio-event listener:', err)
  }
}
