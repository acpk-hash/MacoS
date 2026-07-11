// Artifact store (H3) — 文档/PPT 的 HTML 可视化编辑。
//
// 复用后端 chat_send（会话+流式，事件名 studio-event）来让模型产出完整、自包含
// 的离线 HTML。为不与 studioStore 的「当前会话」耦合，这里维护一个**独立**的
// 隐藏会话，并注册自己的 studio-event 监听，只处理本会话的 delta/done/error。
//
// 单一数据源 = `html` 字符串。左栏对话产 HTML → 写入 html；中栏 Monaco 改源码
// → 写入 html；右栏预览可视化编辑 → applyEdit 写回 html。三者始终同步。

import { create } from 'zustand'
import { extractHtml, ensureHtmlDocument } from '../lib/artifactHtml'
import type { AggModel, Attachment } from './studioStore'

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

interface RawAggModel {
  kind: string
  provider_id: string
  provider_label: string
  model_id: string
}

interface StudioEvent {
  type: string
  session_id?: string
  message_id?: string
  text?: string
  status?: string
  message?: string
}

/** 一条对话记录（仅左栏展示用，非 DB 行）。 */
export interface ArtifactTurn {
  role: 'user' | 'assistant'
  content: string
  /** 用户轮附带的参考文件元信息（仅展示名称，内容已并入发送消息）。 */
  attachments?: { kind: string; name?: string }[]
}

// ── 草稿持久化（localStorage，刷新/重启不丢） ────────────────────────

const DRAFT_KEY = 'agentboard.artifact.draft.v1'

interface DraftSnapshot {
  sessionId: string | null
  turns: ArtifactTurn[]
  html: string
  savedAt: number
}

function loadDraft(): DraftSnapshot | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as DraftSnapshot
    if (typeof d.html !== 'string' || !Array.isArray(d.turns)) return null
    return d
  } catch {
    return null
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}

const initialDraft = loadDraft()

/** 强约束 system 提示：只回一个完整、离线、自包含的 HTML 文档。 */
export const ARTIFACT_SYSTEM_PROMPT = `你是一个「文档 / PPT 的 HTML 生成器」。请严格遵守以下规则：
1. 只输出**一个**完整的 HTML 文档，用一个 \`\`\`html 代码块包裹，代码块外不要有任何多余文字、解释或寒暄。
2. 文档必须**自包含、可离线打开**：所有 CSS 内联在 <style> 里，不引用任何外部资源、CDN、字体或图片 URL；不使用 <script>（用纯 HTML+CSS 实现排版与分页）。
3. 若用户要做 PPT / 幻灯片：每一页用 <section class="slide"> 包裹，页与页之间用 CSS 控制为整屏（例如每个 .slide 高度 100vh、居中排版），风格干净专业。
4. 采用蓝白科研风：主色 #2563eb，背景白色，正文用深灰(slate)，字体使用系统无衬线字体栈。
5. 当用户要求修改时，**返回修改后的完整 HTML 文档**（同样用一个 \`\`\`html 代码块），不要只给片段或 diff。
6. 中文内容，排版整洁，注意留白与层级。`

interface ArtifactStore {
  aggModels: AggModel[]
  modelsLoaded: boolean
  currentModel: string
  currentProviderId: string | null

  sessionId: string | null
  turns: ArtifactTurn[]
  html: string
  streaming: boolean
  error: string | null

  loadModels: () => Promise<void>
  setModelSel: (providerId: string, modelId: string) => void
  /** 用户提交一个需求/修改指令（可附参考文件）→ 让模型产出/更新 HTML。 */
  ask: (prompt: string, attachments?: Attachment[]) => Promise<void>
  stop: () => Promise<void>
  /** 中栏 Monaco 或可视化编辑直接改 HTML 字符串（不触发模型）。 */
  setHtml: (html: string) => void
  /** 把当前草稿（html + 对话 + 会话 id）持久化到本机，刷新不丢。 */
  saveDraft: () => boolean
  /** 清空，开始一个新的文档会话（同时丢弃已保存草稿）。 */
  reset: () => void

  _delta: (messageId: string, text: string) => void
  _done: (messageId: string, status: string, text: string) => void
  _error: (message: string) => void
}

// 流式缓冲：把本轮 assistant 的增量攒起来，done 时一次性提取 HTML。
const streamBuf = new Map<string, string>()

export const useArtifactStore = create<ArtifactStore>((set, get) => ({
  aggModels: [],
  modelsLoaded: false,
  currentModel: '',
  currentProviderId: null,

  sessionId: initialDraft?.sessionId ?? null,
  turns: initialDraft?.turns ?? [],
  html: initialDraft?.html ?? '',
  streaming: false,
  error: null,

  loadModels: async () => {
    if (!isTauri) return
    try {
      const raw = await tauriInvoke<RawAggModel[]>('providers_models')
      // 文档生成走对话模型，只保留 kind=="chat"。
      const aggModels: AggModel[] = raw
        .filter((m) => (m.kind ?? 'chat') === 'chat')
        .map((m) => ({
          providerId: m.provider_id,
          providerLabel: m.provider_label,
          modelId: m.model_id,
          kind: m.kind ?? 'chat',
        }))
      set((s) => {
        const keep =
          !!s.currentModel && aggModels.some((m) => m.modelId === s.currentModel)
        const first = aggModels[0]
        return {
          aggModels,
          modelsLoaded: true,
          error: null,
          currentModel: keep ? s.currentModel : first?.modelId ?? '',
          currentProviderId: keep ? s.currentProviderId : first?.providerId ?? null,
        }
      })
    } catch (e) {
      set({ modelsLoaded: true, error: `模型列表加载失败：${String(e)}` })
    }
  },

  setModelSel: (providerId, modelId) => {
    set({ currentModel: modelId, currentProviderId: providerId })
  },

  ask: async (prompt, attachments = []) => {
    if (!isTauri) return
    const text = prompt.trim()
    if (!text) return
    const model = get().currentModel
    if (!model) {
      set({ error: '尚未选择模型' })
      return
    }
    const providerId = get().currentProviderId

    // 惰性创建一个隐藏会话（标题固定，避免污染「对话」列表语义）。
    let sessionId = get().sessionId
    if (!sessionId) {
      try {
        const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
          title: 'HTML 文档草稿',
          model,
        })
        sessionId = row.id
        set({ sessionId })
      } catch (e) {
        set({ error: `创建会话失败：${String(e)}` })
        return
      }
    }
    const sid = sessionId

    // 首轮把 system 约束前置到用户消息里（后端只存 user/assistant 两种角色，
    // 把强约束塞进第一条 user 文本即可让任何 OpenAI 兼容 relay 生效）。
    const isFirst = get().turns.length === 0
    const userContent = isFirst
      ? `${ARTIFACT_SYSTEM_PROMPT}\n\n———\n用户需求：${text}`
      : text

    set((s) => ({
      turns: [
        ...s.turns,
        {
          role: 'user',
          content: text,
          attachments: attachments.length
            ? attachments.map((a) => ({ kind: a.kind, name: a.name }))
            : undefined,
        },
      ],
      streaming: true,
      error: null,
    }))

    // 附件直接交给后端 chat_send：文本附件内联进用户消息，图片作为
    // image_url 内容块发给模型（见 src-tauri/src/studio.rs build_user_content）。
    try {
      await tauriInvoke<string>('chat_send', {
        sessionId: sid,
        userContent,
        attachments,
        model,
        providerId: providerId ?? null,
      })
    } catch (e) {
      get()._error(String(e))
    }
  },

  stop: async () => {
    const sid = get().sessionId
    if (!sid) return
    try {
      await tauriInvoke<void>('chat_stop', { sessionId: sid })
    } catch (e) {
      console.warn('[artifactStore] stop failed:', e)
    }
  },

  setHtml: (html) => set({ html }),

  saveDraft: () => {
    const s = get()
    try {
      const snap: DraftSnapshot = {
        sessionId: s.sessionId,
        turns: s.turns,
        html: s.html,
        savedAt: Date.now(),
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(snap))
      return true
    } catch {
      return false
    }
  },

  reset: () => {
    streamBuf.clear()
    clearDraft()
    set({ sessionId: null, turns: [], html: '', streaming: false, error: null })
  },

  _delta: (messageId, text) => {
    streamBuf.set(messageId, (streamBuf.get(messageId) ?? '') + text)
  },

  _done: (messageId, _status, text) => {
    const full = text || streamBuf.get(messageId) || ''
    streamBuf.delete(messageId)
    const extracted = extractHtml(full)
    set((s) => {
      const turns: ArtifactTurn[] = [
        ...s.turns,
        { role: 'assistant', content: full },
      ]
      if (extracted) {
        return { turns, streaming: false, html: ensureHtmlDocument(extracted) }
      }
      // 模型没吐出可用 HTML：保留旧 html，仅把回复记进对话。
      return { turns, streaming: false }
    })
  },

  _error: (message) => {
    set({ streaming: false, error: message })
  },
}))

let _unlisten: (() => void) | null = null

/** 注册独立的 studio-event 监听，只消费本 artifact 会话的事件。 */
export async function initArtifactEventListener(): Promise<void> {
  if (_unlisten || !isTauri) return
  try {
    const { listen } = await import('@tauri-apps/api/event')
    _unlisten = await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      const store = useArtifactStore.getState()
      if (!p.session_id || p.session_id !== store.sessionId) return
      switch (p.type) {
        case 'delta':
          if (p.message_id) store._delta(p.message_id, p.text ?? '')
          break
        case 'done':
          if (p.message_id) {
            store._done(p.message_id, p.status ?? 'complete', p.text ?? '')
          }
          break
        case 'error':
          store._error(p.message ?? '生成出错')
          break
        default:
          break
      }
    })
  } catch (err) {
    console.warn('[artifactStore] failed to register studio-event listener:', err)
  }
}
