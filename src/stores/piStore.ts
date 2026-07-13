// piStore — /pi 三栏对话式编码 agent 壳的状态与事件归约（严格仿 pi-app 形态）。
// 后端契约（并行实现中，按契约编写）：
//   pi_open({cwd, providerId?, model?}) → sessionId:string
//   pi_prompt / pi_steer / pi_follow_up({sessionId, message})
//   pi_abort / pi_close({sessionId})
// 事件通道 'pi-event'：payload { sessionId, event:<pi 原始 JSON> }。
import { create } from 'zustand'
import { useTaskRegistry } from './taskRegistryStore'

// 注意：workspaceStore（→ monacoSetup → monaco-editor）只在 openFileInPanel
// 里动态引入，避免把 monaco 拖进主 chunk（PiShell 是首屏页面）。

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
  return 'pi-' + Math.random().toString(36).slice(2)
}

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type PiSessionStatus = 'idle' | 'running' | 'done' | 'error'

/** 已安装 skill（Composer 的 / 选择器数据源，来自 skills_local_list）。 */
export interface PiSkill {
  name: string
  description: string
}

export interface PiSession {
  id: string
  /** 首条 user 消息截断；未发消息前为「新会话」。 */
  title: string
  cwd: string
  model: string
  status: PiSessionStatus
  createdAt: number
}

/** 会话累计 usage（message_end.message.usage 逐条累加）。 */
export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** 已定稿的 assistant 消息数。 */
  turns: number
}

export type PiTimelineItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | {
      id: string
      kind: 'tool'
      toolCallId: string
      toolName: string
      args: unknown
      result?: string
      isError?: boolean
      /** tool_execution_end 尚未到达。 */
      running: boolean
      collapsed: boolean
    }
  | { id: string; kind: 'system'; text: string }

type RawEvent = Record<string, unknown>

interface PiEnvelope {
  sessionId: string
  event: RawEvent
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function clipTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 32 ? one.slice(0, 32) + '…' : one
}

const RESULT_CLIP = 20_000

function clip(s: string): string {
  return s.length > RESULT_CLIP ? s.slice(0, RESULT_CLIP) + '\n……（输出过长，已截断）' : s
}

/** 工具结果 → 展示文本：字符串直用；{content:[{text}]} 取拼接；其余 JSON。 */
function stringifyResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return clip(result)
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (Array.isArray(r.content)) {
      const texts = r.content
        .map((p) =>
          p && typeof p === 'object' ? str((p as Record<string, unknown>).text) : undefined,
        )
        .filter((t): t is string => typeof t === 'string')
      if (texts.length > 0) return clip(texts.join('\n'))
    }
    if (typeof r.output === 'string') return clip(r.output)
    if (typeof r.text === 'string') return clip(r.text)
    try {
      return clip(JSON.stringify(result, null, 2))
    } catch {
      return String(result)
    }
  }
  return String(result)
}

function numField(u: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = u[k]
    if (typeof v === 'number' && isFinite(v)) return v
  }
  return 0
}

const EMPTY_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
}

function addUsage(prev: PiUsage | undefined, u: Record<string, unknown>): PiUsage {
  const base = prev ?? EMPTY_USAGE
  const costRaw = u.cost
  const cost =
    typeof costRaw === 'number'
      ? costRaw
      : costRaw && typeof costRaw === 'object'
        ? numField(costRaw as Record<string, unknown>, 'total')
        : 0
  return {
    input: base.input + numField(u, 'input', 'inputTokens', 'input_tokens'),
    output: base.output + numField(u, 'output', 'outputTokens', 'output_tokens'),
    cacheRead: base.cacheRead + numField(u, 'cacheRead', 'cache_read'),
    cacheWrite: base.cacheWrite + numField(u, 'cacheWrite', 'cache_write'),
    cost: base.cost + cost,
    turns: base.turns + 1,
  }
}

/** message.content 中的 text 部分拼接。 */
function joinTextParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((p) =>
      p && typeof p === 'object' && (p as RawEvent).type === 'text'
        ? str((p as RawEvent).text) ?? ''
        : '',
    )
    .join('')
}

// ── 文件面板辅助 ──────────────────────────────────────────────────────────────

/** 右栏「文件」tab 的预览目标（相对工作区根）。 */
export interface PiFilePreview {
  relPath: string
  name: string
  /** 定位行（来自 path:line 链接），CodeView 打开后 reveal。 */
  line?: number
}

/** 绝对/相对路径 → 工作区 rel_path。越界/含 .. 返回 null。 */
function toWsRel(root: string, p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const sl = s.toLowerCase()
  const rl = r.toLowerCase()
  if (/^([a-zA-Z]:\/|\/)/.test(s)) {
    if (sl === rl) return ''
    if (sl.startsWith(rl + '/')) return s.slice(r.length + 1)
    return null
  }
  if (s.split('/').some((seg) => seg === '..')) return null
  return s
}

/** 剥离末尾的 :行[:列] 后缀，返回 { path, line }。 */
export function splitLineSuffix(raw: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw)
  // Windows 盘符 "D:" 不是行号 —— 要求冒号前至少还有一个路径字符且含扩展名迹象。
  if (m && m[1].length > 2 && /\.[A-Za-z0-9]{1,8}$/.test(m[1])) {
    return { path: m[1], line: parseInt(m[2], 10) }
  }
  return { path: raw }
}

// ── Store 形状 ────────────────────────────────────────────────────────────────

interface PiStore {
  /** 当前打开的项目目录（新会话的 cwd 来源）。 */
  cwd: string | null
  /** 新会话使用的模型（复用 workbenchStore 的 providers_models 数据源，选择态存这里）。 */
  selProviderId: string | null
  selModel: string

  sessions: PiSession[]
  activeSessionId: string | null
  timelineById: Record<string, PiTimelineItem[]>
  /** 每会话的排队消息（运行中输入的、尚未确认送达的消息）。 */
  composerQueue: Record<string, string[]>
  usageById: Record<string, PiUsage>
  listening: boolean
  error: string | null
  /** 已安装 skills 缓存。 */
  installedSkills: PiSkill[]

  // ── 右栏（文件/会话信息）与底部条 UI 状态 ──
  rightOpen: boolean
  rightTab: 'files' | 'info'
  /** 右栏「文件」tab 当前预览的文件（相对工作区根）。 */
  preview: PiFilePreview | null
  bottomOpen: boolean
  bottomTab: 'terminal' | 'ssh'

  setRightOpen: (v: boolean) => void
  setRightTab: (tab: 'files' | 'info') => void
  /** 文件树点击：直接以 rel_path 预览。 */
  previewFile: (relPath: string, name: string, line?: number) => void
  closePreview: () => void
  setBottomOpen: (v: boolean) => void
  setBottomTab: (tab: 'terminal' | 'ssh') => void

  // ── AgentHub 复用钩子 ──
  /** 「在编码中重跑」预填文本：Composer 挂载/更新时消费并清空。 */
  pendingComposerText: string | null
  setPendingComposerText: (text: string | null) => void
  /**
   * 对话内文件链接入口：接受绝对或相对（相对会话 cwd）路径，可带 :行 后缀。
   * 打开右栏「文件」tab、在树中展开定位并预览；找不到时尝试 ws_search 兜底。
   */
  openFileInPanel: (path: string) => Promise<void>

  init: () => Promise<void>
  setCwd: (cwd: string) => void
  setModelSel: (providerId: string | null, modelId: string) => void
  newSession: (cwd: string, model?: string, providerId?: string | null) => Promise<void>
  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  closeSession: (id: string) => Promise<void>
  select: (id: string) => void
  /** 拉取已安装 skills（缓存进 store；force 才强制刷新）。 */
  loadInstalledSkills: (force?: boolean) => Promise<void>
  toggleToolCollapse: (sessionId: string, itemId: string) => void
  clearError: () => void

  _onPiEvent: (sessionId: string, ev: RawEvent) => void
  _applyDeltas: (buf: Map<string, Map<string, string>>) => void
  _pushSystem: (sessionId: string, text: string) => void
}

// ── 流式簿记（模块级，不进 React 状态） ───────────────────────────────────────
// streamingIds: sessionId → 当前正在流式追加的 assistant 条目 id。
// pendingDeltas: rAF 合帧缓冲，避免每个 text_delta 都触发一次全量 set。

const streamingIds = new Map<string, string>()
const pendingDeltas = new Map<string, Map<string, string>>()
let rafHandle: number | null = null

function flushDeltas() {
  rafHandle = null
  if (pendingDeltas.size === 0) return
  const buf = new Map(pendingDeltas)
  pendingDeltas.clear()
  usePiStore.getState()._applyDeltas(buf)
}

function scheduleFlush() {
  if (rafHandle != null) return
  rafHandle =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flushDeltas)
      : (setTimeout(flushDeltas, 16) as unknown as number)
}

function flushNow() {
  if (rafHandle != null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle)
    else clearTimeout(rafHandle)
    rafHandle = null
  }
  flushDeltas()
}

function bufferDelta(sessionId: string, itemId: string, text: string) {
  let m = pendingDeltas.get(sessionId)
  if (!m) {
    m = new Map()
    pendingDeltas.set(sessionId, m)
  }
  m.set(itemId, (m.get(itemId) ?? '') + text)
  scheduleFlush()
}

/** 收尾某会话的流式 assistant 条目（若有）。 */
function finalizeStream(sessionId: string) {
  flushNow()
  const id = streamingIds.get(sessionId)
  if (!id) return
  streamingIds.delete(sessionId)
  usePiStore.setState((s) => patchTimeline(s, sessionId, (items) =>
    items.map((it) =>
      it.id === id && it.kind === 'assistant' ? { ...it, streaming: false } : it,
    ),
  ))
}

// ── 不可变更新助手 ────────────────────────────────────────────────────────────

function patchTimeline(
  s: Pick<PiStore, 'timelineById'>,
  sessionId: string,
  fn: (items: PiTimelineItem[]) => PiTimelineItem[],
): Pick<PiStore, 'timelineById'> {
  const cur = s.timelineById[sessionId] ?? []
  return { timelineById: { ...s.timelineById, [sessionId]: fn(cur) } }
}

function withStatus(
  sessions: PiSession[],
  id: string,
  status: PiSessionStatus,
): PiSession[] {
  return sessions.map((x) => (x.id === id ? { ...x, status } : x))
}

// ── Store ─────────────────────────────────────────────────────────────────────

let listenerStarted = false

export const usePiStore = create<PiStore>((set, get) => ({
  cwd: null,
  selProviderId: null,
  selModel: '',

  sessions: [],
  activeSessionId: null,
  timelineById: {},
  composerQueue: {},
  usageById: {},
  listening: false,
  error: null,
  installedSkills: [],

  rightOpen: true,
  rightTab: 'files',
  preview: null,
  bottomOpen: false,
  bottomTab: 'terminal',

  pendingComposerText: null,
  setPendingComposerText: (text) => set({ pendingComposerText: text }),

  setRightOpen: (v) => set({ rightOpen: v }),
  setRightTab: (tab) => set({ rightTab: tab }),
  previewFile: (relPath, name, line) =>
    set({ preview: { relPath, name, line }, rightTab: 'files', rightOpen: true }),
  closePreview: () => set({ preview: null }),
  setBottomOpen: (v) => set({ bottomOpen: v }),
  setBottomTab: (tab) => set({ bottomTab: tab }),

  openFileInPanel: async (rawPath) => {
    const cleaned = rawPath.trim().replace(/^@/, '')
    if (!cleaned) return
    const { path, line } = splitLineSuffix(cleaned)
    const { useWorkspaceStore } = await import('./workspaceStore')

    // 确保工作区已按会话 cwd 打开（右栏文件树的数据源）。
    const cwd = get().cwd
    let ws = useWorkspaceStore.getState()
    if (!ws.root && cwd) {
      await ws.openFolder(cwd)
      ws = useWorkspaceStore.getState()
    }
    const root = ws.root
    if (!root) {
      set({ error: '尚未打开工作区，无法预览文件' })
      return
    }

    let rel = toWsRel(root, path)
    if (rel == null || rel === '') {
      // 绝对路径在工作区之外，或指向根本身。
      if (rel === '') return
      set({ error: `文件不在当前工作区内：${path}` })
      return
    }

    // 逐级展开父目录（懒加载树）。若目标不存在且是裸文件名，用 ws_search 兜底。
    const ensureDir = async (prefix: string) => {
      if (!useWorkspaceStore.getState().children[prefix]) {
        await useWorkspaceStore.getState().listDir(prefix)
      }
    }
    const expandTo = async (relPath: string): Promise<boolean> => {
      const segs = relPath.split('/')
      const name = segs.pop() ?? relPath
      await ensureDir('')
      let prefix = ''
      for (const s of segs) {
        prefix = prefix ? `${prefix}/${s}` : s
        await ensureDir(prefix)
        if (!useWorkspaceStore.getState().children[prefix]) return false
      }
      const parent = segs.join('/')
      const listing = useWorkspaceStore.getState().children[parent] ?? []
      const found = listing.some((e) => !e.is_dir && e.name === name)
      if (found) {
        useWorkspaceStore.setState((st) => {
          const expanded = new Set(st.expanded)
          expanded.add('')
          let pf = ''
          for (const s of segs) {
            pf = pf ? `${pf}/${s}` : s
            expanded.add(pf)
          }
          return { expanded }
        })
      }
      return found
    }

    let found = await expandTo(rel)
    if (!found && !rel.includes('/') && !useWorkspaceStore.getState().remote) {
      // 裸文件名：全库搜文件名，取 basename 精确匹配的首个命中。
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const hits = await invoke<Array<{ rel_path: string; line: number | null }>>(
          'ws_search',
          { query: rel, max: 50 },
        )
        const hit = hits.find(
          (h) => (h.rel_path.split('/').pop() ?? '').toLowerCase() === rel!.toLowerCase(),
        )
        if (hit) {
          rel = hit.rel_path
          found = await expandTo(rel)
        }
      } catch {
        /* best effort */
      }
    }
    if (!found) {
      set({ error: `未在工作区中找到文件：${path}` })
      return
    }
    const name = rel.split('/').pop() ?? rel
    set({
      preview: { relPath: rel, name, line },
      rightTab: 'files',
      rightOpen: true,
      error: null,
    })
  },

  init: async () => {
    if (!isTauri || listenerStarted) return
    listenerStarted = true
    try {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<PiEnvelope>('pi-event', (evt) => {
        const payload = evt.payload
        if (!payload || typeof payload !== 'object') return
        const { sessionId, event } = payload
        if (!sessionId || !event || typeof event !== 'object') return
        usePiStore.getState()._onPiEvent(sessionId, event)
      })
      set({ listening: true })
    } catch (e) {
      listenerStarted = false
      console.warn('[piStore] failed to register pi-event listener:', e)
    }
  },

  setCwd: (cwd) => set({ cwd }),

  setModelSel: (providerId, modelId) =>
    set({ selProviderId: providerId, selModel: modelId }),

  newSession: async (cwd, model, providerId) => {
    if (!isTauri) {
      set({ error: '仅桌面端可用（Tauri 环境未检测到）' })
      return
    }
    try {
      const sessionId = await tauriInvoke<string>('pi_open', {
        cwd,
        providerId: providerId ?? get().selProviderId ?? null,
        model: model ?? (get().selModel || null),
      })
      const sess: PiSession = {
        id: sessionId,
        title: '新会话',
        cwd,
        model: model ?? get().selModel,
        status: 'idle',
        createdAt: Date.now(),
      }
      set((s) => ({
        sessions: [...s.sessions, sess],
        activeSessionId: sessionId,
        timelineById: { ...s.timelineById, [sessionId]: [] },
        composerQueue: { ...s.composerQueue, [sessionId]: [] },
        usageById: { ...s.usageById, [sessionId]: { ...EMPTY_USAGE } },
        error: null,
      }))
    } catch (e) {
      set({ error: `新建会话失败：${String(e)}` })
    }
  },

  send: async (text) => {
    const body = text.trim()
    if (!body) return
    const id = get().activeSessionId
    if (!id) return
    const sess = get().sessions.find((x) => x.id === id)
    if (!sess) return
    // user 条目立即上时间线（steer 亦然），标题取首条 user 消息。
    set((s) => ({
      ...patchTimeline(s, id, (items) => [
        ...items,
        { id: uuid(), kind: 'user', text: body },
      ]),
      sessions: s.sessions.map((x) =>
        x.id === id && x.title === '新会话' ? { ...x, title: clipTitle(body) } : x,
      ),
      error: null,
    }))
    if (!isTauri) return
    if (sess.status === 'running') {
      // 运行中：入队 + 尝试 steer 即时插话。送达确认（user message_end 匹配队首）
      // 会把它移出队列；若跑完仍未送达，agent_end 用 follow_up 兜底消费队首。
      set((s) => ({
        composerQueue: {
          ...s.composerQueue,
          [id]: [...(s.composerQueue[id] ?? []), body],
        },
      }))
      try {
        await tauriInvoke<void>('pi_steer', { sessionId: id, message: body })
      } catch (e) {
        get()._pushSystem(id, `插话失败：${String(e)}`)
      }
      return
    }
    // done → 先尝试 follow_up 续聊；若 pi 进程已退出则自动重建会话并用 prompt。
    // idle/error → prompt（error 会话按新一轮提问重试）。
    set((s) => ({ sessions: withStatus(s.sessions, id, 'running') }))
    try {
      if (sess.status === 'done') {
        try {
          await tauriInvoke<void>('pi_follow_up', { sessionId: id, message: body })
        } catch {
          // follow_up 失败(进程已退出)→ 重建会话,用 prompt 重新开始。
          get()._pushSystem(id, '会话进程已结束，正在重建…')
          const newId = await tauriInvoke<string>('pi_open', {
            cwd: sess.cwd,
            model: sess.model,
            providerId: get().selProviderId,
          })
          // 把旧会话的 timeline 迁移到新会话(视觉上连续)。
          set((s) => {
            const oldTimeline = s.timelineById[id] ?? []
            return {
              sessions: s.sessions.map((x) =>
                x.id === id ? { ...x, id: newId } : x,
              ),
              activeSessionId: s.activeSessionId === id ? newId : s.activeSessionId,
              timelineById: {
                ...s.timelineById,
                [newId]: oldTimeline,
              },
              composerQueue: {
                ...s.composerQueue,
                [newId]: s.composerQueue[id] ?? [],
              },
              usageById: {
                ...s.usageById,
                [newId]: s.usageById[id],
              },
            }
          })
          await tauriInvoke<void>('pi_prompt', { sessionId: newId, message: body })
        }
      } else {
        await tauriInvoke<void>('pi_prompt', { sessionId: id, message: body })
      }
    } catch (e) {
      get()._pushSystem(id, `发送失败：${String(e)}`)
      set((s) => ({ sessions: withStatus(s.sessions, id, 'error') }))
    }
  },

  abort: async () => {
    const id = get().activeSessionId
    if (!id || !isTauri) return
    try {
      await tauriInvoke<void>('pi_abort', { sessionId: id })
    } catch (e) {
      set({ error: `停止失败：${String(e)}` })
    }
  },

  closeSession: async (id) => {
    if (isTauri) {
      try {
        await tauriInvoke<void>('pi_close', { sessionId: id })
      } catch {
        /* best effort */
      }
    }
    streamingIds.delete(id)
    pendingDeltas.delete(id)
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const timelineById = { ...s.timelineById }
      delete timelineById[id]
      const composerQueue = { ...s.composerQueue }
      delete composerQueue[id]
      const usageById = { ...s.usageById }
      delete usageById[id]
      return {
        sessions,
        timelineById,
        composerQueue,
        usageById,
        activeSessionId:
          s.activeSessionId === id
            ? sessions[sessions.length - 1]?.id ?? null
            : s.activeSessionId,
      }
    })
  },

  select: (id) => set({ activeSessionId: id }),

  loadInstalledSkills: async (force) => {
    if (!isTauri) return
    if (!force && get().installedSkills.length > 0) return
    try {
      const list = await tauriInvoke<PiSkill[]>('skills_local_list')
      set({ installedSkills: list.map((x) => ({ name: x.name, description: x.description })) })
    } catch (e) {
      console.warn('[piStore] skills_local_list failed:', e)
    }
  },

  toggleToolCollapse: (sessionId, itemId) =>
    set((s) =>
      patchTimeline(s, sessionId, (items) =>
        items.map((it) =>
          it.id === itemId && it.kind === 'tool'
            ? { ...it, collapsed: !it.collapsed }
            : it,
        ),
      ),
    ),

  clearError: () => set({ error: null }),

  _applyDeltas: (buf) => {
    set((s) => {
      const timelineById = { ...s.timelineById }
      buf.forEach((m, sessionId) => {
        const items = timelineById[sessionId]
        if (!items) return
        timelineById[sessionId] = items.map((it) => {
          if (it.kind !== 'assistant') return it
          const add = m.get(it.id)
          return add ? { ...it, text: it.text + add } : it
        })
      })
      return { timelineById }
    })
  },

  _pushSystem: (sessionId, text) => {
    set((s) =>
      patchTimeline(s, sessionId, (items) => [
        ...items,
        { id: uuid(), kind: 'system', text },
      ]),
    )
  },

  // ── 事件归约（核心） ────────────────────────────────────────────────────────
  _onPiEvent: (sessionId, ev) => {
    // 会话可能已被关闭：丢弃迟到事件。
    if (!get().sessions.some((x) => x.id === sessionId)) return
    const type = String(ev.type ?? '')
    switch (type) {
      case 'agent_start':
      case 'turn_start': {
        set((s) => ({ sessions: withStatus(s.sessions, sessionId, 'running') }))
        // 全局任务条：编码任务注册/更新为 running。
        {
          const sess = get().sessions.find((x) => x.id === sessionId)
          if (sess) {
            useTaskRegistry.getState().registerTask({
              id: 'coding-' + sessionId,
              module: 'coding',
              title: sess.title || '编码任务',
            })
          }
        }
        break
      }

      case 'message_update': {
        // 只消费 text_delta；追加到当前流式 assistant 条目（没有就建一条）。
        const ame = ev.assistantMessageEvent as RawEvent | undefined
        if (!ame || str(ame.type) !== 'text_delta') break
        const delta = str(ame.delta) ?? ''
        let itemId = streamingIds.get(sessionId)
        if (!itemId) {
          itemId = uuid()
          streamingIds.set(sessionId, itemId)
          const created = itemId
          set((s) =>
            patchTimeline(s, sessionId, (items) => [
              ...items,
              { id: created, kind: 'assistant', text: '', streaming: true },
            ]),
          )
        }
        bufferDelta(sessionId, itemId, delta)
        break
      }

      case 'message_end': {
        const msg = ev.message as RawEvent | undefined
        if (!msg) break
        const role = str(msg.role)
        if (role === 'assistant') {
          flushNow()
          const content = Array.isArray(msg.content)
            ? (msg.content as RawEvent[])
            : []
          const finalText = joinTextParts(content)
          const streamId = streamingIds.get(sessionId)
          streamingIds.delete(sessionId)
          const usage =
            msg.usage && typeof msg.usage === 'object'
              ? (msg.usage as Record<string, unknown>)
              : null
          set((s) => {
            const patch = patchTimeline(s, sessionId, (items) => {
              let next = items
              // 定稿：有流式条目则以 message_end 文本为准；否则（无任何 delta）补一条。
              if (streamId) {
                next = next.map((it) =>
                  it.id === streamId && it.kind === 'assistant'
                    ? { ...it, text: finalText || it.text, streaming: false }
                    : it,
                )
              } else if (finalText.trim()) {
                next = [
                  ...next,
                  { id: uuid(), kind: 'assistant', text: finalText, streaming: false },
                ]
              }
              // toolCall 内容块：与 tool_execution_start 二选一建条目，toolCallId 去重。
              // content 里的 toolCall 若无 id（契约未保证），交给 tool_execution_start 建。
              for (const p of content) {
                if (!p || p.type !== 'toolCall') continue
                const tcId = str(p.id) ?? str(p.toolCallId)
                if (!tcId) continue
                if (next.some((it) => it.kind === 'tool' && it.toolCallId === tcId)) {
                  continue
                }
                next = [
                  ...next,
                  {
                    id: uuid(),
                    kind: 'tool',
                    toolCallId: tcId,
                    toolName: str(p.name) ?? 'tool',
                    args: p.arguments,
                    running: true,
                    collapsed: true,
                  },
                ]
              }
              return next
            })
            return usage
              ? {
                  ...patch,
                  usageById: {
                    ...s.usageById,
                    [sessionId]: addUsage(s.usageById[sessionId], usage),
                  },
                }
              : patch
          })
        } else if (role === 'user') {
          // steer 消息送达确认：与队首完全一致 → 出队（避免 agent_end 再 follow_up 一次）。
          const text = joinTextParts(msg.content).trim()
          if (!text) break
          set((s) => {
            const q = s.composerQueue[sessionId] ?? []
            if (q.length > 0 && q[0] === text) {
              return {
                composerQueue: { ...s.composerQueue, [sessionId]: q.slice(1) },
              }
            }
            return {}
          })
        }
        break
      }

      case 'tool_execution_start': {
        const tcId = str(ev.toolCallId)
        if (!tcId) break
        const toolName = str(ev.toolName) ?? 'tool'
        const args = ev.args
        set((s) =>
          patchTimeline(s, sessionId, (items) => {
            const idx = items.findIndex(
              (it) => it.kind === 'tool' && it.toolCallId === tcId,
            )
            if (idx >= 0) {
              // 已由 message_end 的 toolCall 建过：补齐名称/参数即可。
              const next = items.slice()
              const it = next[idx] as Extract<PiTimelineItem, { kind: 'tool' }>
              next[idx] = { ...it, toolName, args: args ?? it.args, running: true }
              return next
            }
            return [
              ...items,
              {
                id: uuid(),
                kind: 'tool',
                toolCallId: tcId,
                toolName,
                args,
                running: true,
                collapsed: true,
              },
            ]
          }),
        )
        break
      }

      case 'tool_execution_update': {
        // 契约未细化 update 载荷；有 result 就当进行中预览，否则忽略。
        const tcId = str(ev.toolCallId)
        if (!tcId || ev.result === undefined) break
        const preview = stringifyResult(ev.result)
        set((s) =>
          patchTimeline(s, sessionId, (items) =>
            items.map((it) =>
              it.kind === 'tool' && it.toolCallId === tcId
                ? { ...it, result: preview }
                : it,
            ),
          ),
        )
        break
      }

      case 'tool_execution_end': {
        const tcId = str(ev.toolCallId)
        if (!tcId) break
        const isError = ev.isError === true
        const result = stringifyResult(ev.result)
        set((s) =>
          patchTimeline(s, sessionId, (items) =>
            items.map((it) =>
              it.kind === 'tool' && it.toolCallId === tcId
                ? {
                    ...it,
                    result,
                    isError,
                    running: false,
                    // 出错默认展开，便于一眼看到失败原因。
                    collapsed: isError ? false : it.collapsed,
                  }
                : it,
            ),
          ),
        )
        break
      }

      case 'turn_end': {
        finalizeStream(sessionId)
        break
      }

      case 'agent_end': {
        // willRetry=true 表示 pi 遇到瞬时错误将自动重试，这一轮尚未终结——
        // 保持 running，不消费队列、不收尾（实测 relay 偶发超时时会出现）。
        if ((ev as { willRetry?: boolean }).willRetry === true) break
        finalizeStream(sessionId)
        const q = get().composerQueue[sessionId] ?? []
        if (q.length > 0) {
          // 消费队首：steer 没送达的消息自动转 follow_up 续跑。
          const head = q[0]
          set((s) => ({
            composerQueue: {
              ...s.composerQueue,
              [sessionId]: (s.composerQueue[sessionId] ?? []).slice(1),
            },
            sessions: withStatus(s.sessions, sessionId, 'running'),
          }))
          void tauriInvoke<void>('pi_follow_up', {
            sessionId,
            message: head,
          }).catch((e) => {
            get()._pushSystem(sessionId, `排队消息发送失败：${String(e)}`)
            set((s) => ({ sessions: withStatus(s.sessions, sessionId, 'error') }))
          })
        } else {
          set((s) => ({ sessions: withStatus(s.sessions, sessionId, 'done') }))
        }
        // 全局任务条：编码任务标记完成。
        useTaskRegistry.getState().updateTask('coding-' + sessionId, { status: 'done' })
        // 存档钩子：会话在此定稿，把快照推给 AgentHub 工作流存档
        // （动态引入避免环依赖；同会话多轮 agent_end 会 upsert 同一条）。
        const st = get()
        const ended = st.sessions.find((x) => x.id === sessionId)
        if (ended) {
          const snapshot = {
            session: ended,
            timeline: st.timelineById[sessionId] ?? [],
            usage: st.usageById[sessionId],
          }
          void import('./agentHubStore')
            .then((m) => m.useAgentHubStore.getState().archiveSession(snapshot))
            .catch(() => {})
        }
        break
      }

      case 'error': {
        finalizeStream(sessionId)
        const text =
          str(ev.message) ?? str(ev.error) ?? '发生未知错误'
        set((s) => ({
          ...patchTimeline(s, sessionId, (items) => [
            ...items,
            { id: uuid(), kind: 'system', text: `错误：${text}` },
          ]),
          sessions: withStatus(s.sessions, sessionId, 'error'),
        }))
        // 全局任务条：编码任务标记错误。
        useTaskRegistry.getState().updateTask('coding-' + sessionId, { status: 'error', detail: text })
        break
      }

      case 'process_exit': {
        finalizeStream(sessionId)
        const code = typeof ev.code === 'number' ? ev.code : null
        const tail = str(ev.stderr_tail)?.trim()
        const text =
          `进程已退出（code ${code ?? '未知'}）` + (tail ? `\n${tail}` : '')
        set((s) => ({
          ...patchTimeline(s, sessionId, (items) => [
            ...items,
            { id: uuid(), kind: 'system', text },
          ]),
          sessions: withStatus(s.sessions, sessionId, 'error'),
        }))
        // 全局任务条：编码任务标记错误。
        useTaskRegistry.getState().updateTask('coding-' + sessionId, { status: 'error', detail: text })
        break
      }

      default:
        // agent_start/turn_start 之外的未识别事件静默忽略（前向兼容）。
        break
    }
  },
}))
