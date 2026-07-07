import { create } from 'zustand'
import type { AggModel } from './studioStore'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Raw shape from the providers_models command (snake_case from serde). */
interface RawAggModel {
  provider_id: string
  provider_label: string
  model_id: string
}

/** Token usage snapshot (mirrors Rust WorkbenchStats). */
export interface WorkbenchStats {
  input: number
  output: number
  cache_read: number
  cache_write: number
  total: number
  cost: number
  context_tokens: number
  context_window: number
  context_percent: number
}

const ZERO_STATS: WorkbenchStats = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  total: 0,
  cost: 0,
  context_tokens: 0,
  context_window: 0,
  context_percent: 0,
}

/** One ordered item in the pi-style output stream. */
export type WorkbenchEntry =
  | { id: string; kind: 'user'; text: string; steer?: boolean }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'thinking'; text: string; streaming: boolean }
  | {
      id: string
      kind: 'tool_bash'
      toolCallId: string
      cmd: string
      output: string
      exitCode: number | null
    }
  | { id: string; kind: 'tool_edit'; toolCallId: string; path: string; diff: string }
  | { id: string; kind: 'tool_write'; toolCallId: string; path: string }
  | {
      id: string
      kind: 'tool_result'
      toolCallId: string
      tool: string
      output: string
      isError: boolean
    }
  | { id: string; kind: 'error'; text: string }

/** A file the agent has touched this session (latest edit/write wins). */
export interface TouchedFile {
  path: string
  kind: 'edit' | 'write'
  /** id of the entry to scroll to (latest touch). */
  entryId: string
}

/** The decoded event carried on the `workbench-event` channel. */
interface WorkbenchEventRaw {
  type: string
  text?: string
  message?: string
  tool_call_id?: string
  tool?: string
  path?: string
  cmd?: string
  output?: string
  exit_code?: number | null
  diff?: string
  is_error?: boolean
  input?: number
  output_tokens?: number
  cache_read?: number
  cache_write?: number
  total?: number
  cost?: number
  context_tokens?: number
  context_window?: number
  context_percent?: number
}

interface WorkbenchEnvelope {
  session_id: string
  event: Record<string, unknown>
}

// ── Tauri helpers ─────────────────────────────────────────────────────────────

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

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'wb-' + Math.random().toString(36).slice(2)
}

function baseName(p: string): string {
  const parts = p.split(/[\/]/)
  return parts[parts.length - 1] || p
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface WorkbenchStore {
  aggModels: AggModel[]
  currentModel: string
  currentProviderId: string | null
  modelsLoaded: boolean

  sessionId: string | null
  dir: string | null
  opening: boolean
  running: boolean

  entries: WorkbenchEntry[]
  files: TouchedFile[]
  tokens: WorkbenchStats

  progressAction: string
  turnStartedAt: number | null

  error: string | null
  notice: string | null

  loadModels: () => Promise<void>
  setModelSel: (providerId: string, modelId: string) => void
  pickAndOpen: () => Promise<void>
  open: (dir: string) => Promise<void>
  switchModel: (providerId: string, modelId: string) => Promise<void>
  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  exportHtml: () => Promise<void>
  close: () => Promise<void>
  clearNotice: () => void

  reuseRequest: { cwd: string; model: string; prompt: string } | null
  requestReuse: (req: { cwd: string; model: string; prompt: string }) => void
  consumeReuse: () => Promise<string | null>

  _onEvent: (sessionId: string, ev: WorkbenchEventRaw) => void
  _applyBufferedDeltas: (buf: Map<string, string>) => void
}

// Module-scope streaming bookkeeping (kept out of React state).
let curAssistantId: string | null = null
let curThinkingId: string | null = null
const pending = new Map<string, string>()
let rafHandle: number | null = null

function scheduleFlush() {
  if (rafHandle != null) return
  rafHandle =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushDeltas)
      : (setTimeout(flushDeltas, 16) as unknown as number)
}

function flushDeltas() {
  rafHandle = null
  if (pending.size === 0) return
  const buf = new Map(pending)
  pending.clear()
  useWorkbenchStore.getState()._applyBufferedDeltas(buf)
}

function flushNow() {
  if (rafHandle != null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle)
    else clearTimeout(rafHandle)
    rafHandle = null
  }
  flushDeltas()
}

function bufferDelta(entryId: string, text: string) {
  pending.set(entryId, (pending.get(entryId) ?? '') + text)
  scheduleFlush()
}

type SetFn = (
  fn: (s: WorkbenchStore) => Partial<WorkbenchStore>,
) => void

/** Finalize any open streaming assistant/thinking entries. */
function closeStreams(set: SetFn) {
  flushNow()
  const openIds = [curAssistantId, curThinkingId].filter(Boolean) as string[]
  curAssistantId = null
  curThinkingId = null
  if (openIds.length === 0) return
  set((s) => ({
    entries: s.entries.map((e) =>
      openIds.includes(e.id) &&
      (e.kind === 'assistant' || e.kind === 'thinking')
        ? { ...e, streaming: false }
        : e,
    ),
  }))
}

function upsertFile(
  files: TouchedFile[],
  path: string,
  kind: 'edit' | 'write',
  entryId: string,
): TouchedFile[] {
  const idx = files.findIndex((f) => f.path === path)
  if (idx >= 0) {
    const next = files.slice()
    next[idx] = { path, kind, entryId }
    return next
  }
  return [...files, { path, kind, entryId }]
}

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  aggModels: [],
  currentModel: '',
  currentProviderId: null,
  modelsLoaded: false,

  sessionId: null,
  dir: null,
  opening: false,
  running: false,

  entries: [],
  files: [],
  tokens: { ...ZERO_STATS },

  progressAction: '',
  turnStartedAt: null,

  error: null,
  notice: null,

  reuseRequest: null,

  loadModels: async () => {
    if (!isTauri) return
    try {
      const raw = await tauriInvoke<RawAggModel[]>('providers_models')
      const aggModels: AggModel[] = raw.map((m) => ({
        providerId: m.provider_id,
        providerLabel: m.provider_label,
        modelId: m.model_id,
      }))
      set((s) => {
        const keep =
          !!s.currentModel && aggModels.some((m) => m.modelId === s.currentModel)
        const first = aggModels[0]
        return {
          aggModels,
          modelsLoaded: true,
          currentModel: keep ? s.currentModel : first?.modelId ?? '',
          currentProviderId: keep ? s.currentProviderId : first?.providerId ?? null,
        }
      })
    } catch (e) {
      set({ modelsLoaded: true, error: `模型列表加载失败：${String(e)}` })
    }
  },

  setModelSel: (providerId, modelId) => {
    set({ currentProviderId: providerId, currentModel: modelId })
  },

  pickAndOpen: async () => {
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ directory: true, multiple: false })
      if (typeof picked === 'string') {
        await get().open(picked)
      }
    } catch (e) {
      set({ error: `选择文件夹失败：${String(e)}` })
    }
  },

  open: async (dir) => {
    if (!isTauri) return
    const model = get().currentModel
    if (!model) {
      set({ error: '尚未选择模型，请先在设置中配置服务商' })
      return
    }
    set({
      opening: true,
      error: null,
      entries: [],
      files: [],
      tokens: { ...ZERO_STATS },
      progressAction: '',
      running: false,
    })
    curAssistantId = null
    curThinkingId = null
    pending.clear()
    try {
      const res = await tauriInvoke<{
        session_id: string
        provider_id: string
        model: string
      }>('workbench_open', {
        dir,
        providerId: get().currentProviderId ?? null,
        model,
      })
      set({
        sessionId: res.session_id,
        dir,
        currentProviderId: res.provider_id,
        currentModel: res.model,
        opening: false,
      })
    } catch (e) {
      set({ opening: false, error: `工作台启动失败：${String(e)}` })
    }
  },

  switchModel: async (providerId, modelId) => {
    set({ currentProviderId: providerId, currentModel: modelId })
    if (!isTauri || !get().sessionId) return
    set({
      opening: true,
      error: null,
      entries: [],
      files: [],
      tokens: { ...ZERO_STATS },
      progressAction: '',
      running: false,
    })
    curAssistantId = null
    curThinkingId = null
    pending.clear()
    try {
      const res = await tauriInvoke<{
        session_id: string
        provider_id: string
        model: string
      }>('workbench_set_model', {
        providerId: providerId ?? null,
        model: modelId,
      })
      set({
        sessionId: res.session_id,
        currentProviderId: res.provider_id,
        currentModel: res.model,
        opening: false,
        notice: '已切换模型，开启了新的会话（上下文已重置）',
      })
    } catch (e) {
      set({ opening: false, error: `切换模型失败：${String(e)}` })
    }
  },

  send: async (text) => {
    const body = text.trim()
    if (!body || !isTauri) return
    const { sessionId, running } = get()
    if (!sessionId) return
    const steer = running
    set((s) => ({
      entries: [...s.entries, { id: uuid(), kind: 'user', text: body, steer }],
      running: true,
      turnStartedAt: steer ? s.turnStartedAt ?? Date.now() : Date.now(),
      progressAction: steer ? s.progressAction : '思考中…',
      error: null,
    }))
    try {
      await tauriInvoke<void>(steer ? 'workbench_steer' : 'workbench_prompt', {
        text: body,
      })
    } catch (e) {
      set({ error: `发送失败：${String(e)}`, running: false })
    }
  },

  abort: async () => {
    if (!isTauri) return
    try {
      await tauriInvoke<void>('workbench_abort')
    } catch (e) {
      set({ error: `停止失败：${String(e)}` })
    }
  },

  exportHtml: async () => {
    if (!isTauri || !get().sessionId) return
    try {
      const path = await tauriInvoke<string>('workbench_export_html')
      set({ notice: path ? `已导出 HTML 到：${path}` : '已导出 HTML' })
    } catch (e) {
      set({ error: `导出失败：${String(e)}` })
    }
  },

  close: async () => {
    if (isTauri) {
      try {
        await tauriInvoke<void>('workbench_close')
      } catch {
        /* best effort */
      }
    }
    curAssistantId = null
    curThinkingId = null
    pending.clear()
    set({
      sessionId: null,
      dir: null,
      running: false,
      entries: [],
      files: [],
      tokens: { ...ZERO_STATS },
      progressAction: '',
      turnStartedAt: null,
    })
  },

  clearNotice: () => set({ notice: null, error: null }),

  requestReuse: (req) => set({ reuseRequest: req }),

  consumeReuse: async () => {
    const req = get().reuseRequest
    if (!req) return null
    set({ reuseRequest: null })
    const agg = get().aggModels.find((m) => m.modelId === req.model)
    if (agg) set({ currentProviderId: agg.providerId, currentModel: agg.modelId })
    await get().open(req.cwd)
    return req.prompt
  },

  _applyBufferedDeltas: (buf) => {
    set((s) => ({
      entries: s.entries.map((e) => {
        const add = buf.get(e.id)
        if (add == null) return e
        if (e.kind === 'assistant' || e.kind === 'thinking') {
          return { ...e, text: e.text + add }
        }
        return e
      }),
    }))
  },

  _onEvent: (sessionId, ev) => {
    if (sessionId !== get().sessionId) return
    switch (ev.type) {
      case 'assistant_delta': {
        if (curThinkingId) closeStreams(set)
        const text = ev.text ?? ''
        if (!curAssistantId) {
          const id = uuid()
          curAssistantId = id
          set((s) => ({
            entries: [
              ...s.entries,
              { id, kind: 'assistant', text: '', streaming: true },
            ],
            progressAction: '生成回复中…',
          }))
        }
        bufferDelta(curAssistantId, text)
        break
      }
      case 'assistant_message': {
        flushNow()
        const text = ev.text ?? ''
        const id = curAssistantId
        curAssistantId = null
        set((s) => {
          if (id && s.entries.some((e) => e.id === id)) {
            return {
              entries: s.entries.map((e) =>
                e.id === id && e.kind === 'assistant'
                  ? { ...e, text, streaming: false }
                  : e,
              ),
            }
          }
          if (!text) return {}
          return {
            entries: [
              ...s.entries,
              { id: uuid(), kind: 'assistant', text, streaming: false },
            ],
          }
        })
        break
      }
      case 'thinking': {
        if (curAssistantId) closeStreams(set)
        const text = ev.text ?? ''
        if (!curThinkingId) {
          const id = uuid()
          curThinkingId = id
          set((s) => ({
            entries: [
              ...s.entries,
              { id, kind: 'thinking', text: '', streaming: true },
            ],
            progressAction: '思考中…',
          }))
        }
        bufferDelta(curThinkingId, text)
        break
      }
      case 'tool_started': {
        closeStreams(set)
        const tool = ev.tool ?? ''
        let action = '执行工具…'
        if (tool === 'bash') action = ev.cmd ? `运行命令：${ev.cmd}` : '运行命令…'
        else if (tool === 'edit') action = `正在编辑 ${baseName(ev.path ?? '')}`
        else if (tool === 'write') action = `正在写入 ${baseName(ev.path ?? '')}`
        else if (tool === 'read') action = `读取 ${baseName(ev.path ?? '')}`
        else action = `执行 ${tool}…`
        set({ progressAction: action })
        break
      }
      case 'tool_bash': {
        closeStreams(set)
        set((s) => ({
          entries: [
            ...s.entries,
            {
              id: uuid(),
              kind: 'tool_bash',
              toolCallId: ev.tool_call_id ?? '',
              cmd: ev.cmd ?? '',
              output: ev.output ?? '',
              exitCode: ev.exit_code ?? null,
            },
          ],
        }))
        break
      }
      case 'tool_edit': {
        closeStreams(set)
        const path = ev.path ?? ''
        const id = uuid()
        set((s) => ({
          entries: [
            ...s.entries,
            {
              id,
              kind: 'tool_edit',
              toolCallId: ev.tool_call_id ?? '',
              path,
              diff: ev.diff ?? '',
            },
          ],
          files: upsertFile(s.files, path, 'edit', id),
        }))
        break
      }
      case 'tool_write': {
        closeStreams(set)
        const path = ev.path ?? ''
        const id = uuid()
        set((s) => ({
          entries: [
            ...s.entries,
            { id, kind: 'tool_write', toolCallId: ev.tool_call_id ?? '', path },
          ],
          files: upsertFile(s.files, path, 'write', id),
        }))
        break
      }
      case 'tool_result': {
        closeStreams(set)
        set((s) => ({
          entries: [
            ...s.entries,
            {
              id: uuid(),
              kind: 'tool_result',
              toolCallId: ev.tool_call_id ?? '',
              tool: ev.tool ?? '',
              output: ev.output ?? '',
              isError: ev.is_error ?? false,
            },
          ],
        }))
        break
      }
      case 'token_stats': {
        set({
          tokens: {
            input: ev.input ?? 0,
            output: ev.output_tokens ?? 0,
            cache_read: ev.cache_read ?? 0,
            cache_write: ev.cache_write ?? 0,
            total: ev.total ?? 0,
            cost: ev.cost ?? 0,
            context_tokens: ev.context_tokens ?? 0,
            context_window: ev.context_window ?? 0,
            context_percent: ev.context_percent ?? 0,
          },
        })
        break
      }
      case 'turn_started': {
        set((s) => ({
          running: true,
          turnStartedAt: s.turnStartedAt ?? Date.now(),
          progressAction: s.progressAction || '思考中…',
        }))
        break
      }
      case 'turn_completed': {
        closeStreams(set)
        set({ running: false, progressAction: '', turnStartedAt: null })
        break
      }
      case 'error': {
        closeStreams(set)
        set((s) => ({
          entries: [
            ...s.entries,
            { id: uuid(), kind: 'error', text: ev.message ?? '出错' },
          ],
          running: false,
          progressAction: '',
          turnStartedAt: null,
        }))
        break
      }
      default:
        break
    }
  },
}))

// ── Event listener (registered once) ──────────────────────────────────────────

let _unlisten: (() => void) | null = null

export async function initWorkbenchEventListener(): Promise<void> {
  if (_unlisten || !isTauri) return
  try {
    const { listen } = await import('@tauri-apps/api/event')
    _unlisten = await listen<WorkbenchEnvelope>('workbench-event', (evt) => {
      const { session_id, event } = evt.payload
      if (!event || typeof event !== 'object') return
      const raw = event as Record<string, unknown>
      const mapped: WorkbenchEventRaw = {
        type: String(raw.type ?? ''),
        text: raw.text as string | undefined,
        message: raw.message as string | undefined,
        tool_call_id: raw.tool_call_id as string | undefined,
        tool: raw.tool as string | undefined,
        path: raw.path as string | undefined,
        cmd: raw.cmd as string | undefined,
        output: raw.output as string | undefined,
        exit_code: raw.exit_code as number | null | undefined,
        diff: raw.diff as string | undefined,
        is_error: raw.is_error as boolean | undefined,
        input: raw.input as number | undefined,
        // TokenStats serializes its output field as `output`; remap it so it
        // does not collide with tool output decoding above.
        output_tokens:
          raw.type === 'token_stats' ? (raw.output as number | undefined) : undefined,
        cache_read: raw.cache_read as number | undefined,
        cache_write: raw.cache_write as number | undefined,
        total: raw.total as number | undefined,
        cost: raw.cost as number | undefined,
        context_tokens: raw.context_tokens as number | undefined,
        context_window: raw.context_window as number | undefined,
        context_percent: raw.context_percent as number | undefined,
      }
      useWorkbenchStore.getState()._onEvent(session_id, mapped)
    })
  } catch (err) {
    console.warn('[workbenchStore] failed to register workbench-event listener:', err)
  }
}
