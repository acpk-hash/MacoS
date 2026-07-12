// piStore — /pi 三栏对话式编码 agent 壳的状态与事件归约（严格仿 pi-app 形态）。
// 后端契约（并行实现中，按契约编写）：
//   pi_open({cwd, providerId?, model?}) → sessionId:string
//   pi_prompt / pi_steer / pi_follow_up({sessionId, message})
//   pi_abort / pi_close({sessionId})
// 事件通道 'pi-event'：payload { sessionId, event:<pi 原始 JSON> }。
import { create } from 'zustand'

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

  init: () => Promise<void>
  setCwd: (cwd: string) => void
  setModelSel: (providerId: string | null, modelId: string) => void
  newSession: (cwd: string, model?: string, providerId?: string | null) => Promise<void>
  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  closeSession: (id: string) => Promise<void>
  select: (id: string) => void
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
    // done → follow_up 续聊；idle/error → prompt（error 会话按新一轮提问重试）。
    const command = sess.status === 'done' ? 'pi_follow_up' : 'pi_prompt'
    set((s) => ({ sessions: withStatus(s.sessions, id, 'running') }))
    try {
      await tauriInvoke<void>(command, { sessionId: id, message: body })
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
        break
      }

      default:
        // agent_start/turn_start 之外的未识别事件静默忽略（前向兼容）。
        break
    }
  },
}))
