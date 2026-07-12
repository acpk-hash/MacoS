// Artifact store (H3) — 文档/PPT 的 HTML 可视化编辑。
//
// v0.9 起改为「两阶段」流程（claude.ai/design 式）：
//   阶段一 规划：用户描述需求 → 模型只产出结构化规划（markdown，不出 HTML）；
//   阶段二 确认：用户可直接编辑规划文本，或再对话让模型修订规划；
//   阶段三 生成：确认后把最终规划作为强上下文，让模型生成完整自包含 HTML。
// 状态机：idle → planning → plan_ready → generating → done。
// done 之后继续对话即「改 HTML」轮（内部短暂回到 generating，完成后回 done）。
//
// 复用后端 chat_send（会话+流式，事件名 studio-event）来让模型产出规划与 HTML。
// 为不与 studioStore 的「当前会话」耦合，这里维护一个**独立**的隐藏会话，并注册
// 自己的 studio-event 监听，只处理本会话的 delta/done/error。
//
// 单一数据源 = `html` 字符串。左栏对话产 HTML → 写入 html；中栏 Monaco 改源码
// → 写入 html；右栏预览可视化编辑 → applyEdit 写回 html。三者始终同步。
// 规划阶段的单一数据源 = `plan` 字符串（markdown），确认面板直接读/写它。

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

/** 两阶段流程的阶段状态机。 */
export type ArtifactStage =
  | 'idle'
  | 'planning'
  | 'plan_ready'
  | 'generating'
  | 'done'

/** 一条对话记录（仅左栏展示用，非 DB 行）。 */
export interface ArtifactTurn {
  role: 'user' | 'assistant'
  content: string
  /** assistant 轮产物类型：plan=规划文本，html=HTML 文档（旧草稿无此字段=html）。 */
  kind?: 'plan' | 'html'
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
  /** v0.9 起：规划文本也随草稿持久化（旧草稿无此字段）。 */
  plan?: string
}

/** 从产物推断可恢复的阶段（流式中间态 planning/generating 不可恢复）。 */
function inferStage(plan: string, html: string): ArtifactStage {
  if (html) return 'done'
  if (plan) return 'plan_ready'
  return 'idle'
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
const initialPlan =
  typeof initialDraft?.plan === 'string' ? initialDraft.plan : ''
const initialHtml = initialDraft?.html ?? ''

/** 阶段一 system 提示：只输出结构化规划（markdown），绝不输出 HTML。 */
export const ARTIFACT_PLAN_PROMPT = `你是一个「文档 / PPT 的规划助手」。用户会描述想要的文档或幻灯片，你的任务是**只输出一份结构化规划（markdown），绝对不要输出任何 HTML 代码**。请严格遵守：
1. 若用户要做 PPT / 幻灯片：先给出总页数；再逐页列出「第 N 页：标题」+ 每页 2~4 条要点；最后给出整体叙事线（一两句话）和视觉方向建议（配色 / 风格 / 版式）。
2. 若用户要做文档：给出章节大纲，每节列 2~4 条要点；最后给出整体风格建议。
3. 输出格式：markdown 标题 + 列表，中文，清晰简洁；不要代码块、不要 HTML、不要寒暄和解释。
4. 之后用户可能要求调整规划：同样只输出修订后的**完整规划**（markdown），仍然禁止输出 HTML。`

/** 强约束 system 提示：只回一个完整、离线、自包含的 HTML 文档。 */
export const ARTIFACT_SYSTEM_PROMPT = `你是一个「文档 / PPT 的 HTML 生成器」。请严格遵守以下规则：
1. 只输出**一个**完整的 HTML 文档，用一个 \`\`\`html 代码块包裹，代码块外不要有任何多余文字、解释或寒暄。
2. 文档必须**自包含、可离线打开**：所有 CSS 内联在 <style> 里，不引用任何外部资源、CDN、字体或图片 URL；不使用 <script>（用纯 HTML+CSS 实现排版与分页）。
3. 若用户要做 PPT / 幻灯片：每一页用 <section class="slide"> 包裹，页与页之间用 CSS 控制为整屏（例如每个 .slide 高度 100vh、居中排版），风格干净专业。
4. 采用蓝白科研风：主色 #2563eb，背景白色，正文用深灰(slate)，字体使用系统无衬线字体栈；若规划里给出了其他视觉方向，以规划为准。
5. 当用户要求修改时，**返回修改后的完整 HTML 文档**（同样用一个 \`\`\`html 代码块），不要只给片段或 diff。
6. 中文内容，排版整洁，注意留白与层级。`

interface ArtifactStore {
  aggModels: AggModel[]
  modelsLoaded: boolean
  currentModel: string
  currentProviderId: string | null

  sessionId: string | null
  turns: ArtifactTurn[]
  /** 两阶段状态机：idle → planning → plan_ready → generating → done。 */
  stage: ArtifactStage
  /** 阶段一/二的规划文本（markdown），确认面板可直接编辑。 */
  plan: string
  html: string
  streaming: boolean
  error: string | null

  loadModels: () => Promise<void>
  setModelSel: (providerId: string, modelId: string) => void
  /** 用户提交一段话（可附参考文件）。按阶段路由：
   *  idle → 请求规划；plan_ready → 请求修订规划；done → 请求修改 HTML。 */
  ask: (prompt: string, attachments?: Attachment[]) => Promise<void>
  /** 确认当前规划 → 以最终规划为强上下文让模型生成完整 HTML。 */
  confirmPlan: () => Promise<void>
  stop: () => Promise<void>
  /** 确认面板直接编辑规划文本（不触发模型）。 */
  setPlan: (plan: string) => void
  /** 中栏 Monaco 或可视化编辑直接改 HTML 字符串（不触发模型）。 */
  setHtml: (html: string) => void
  /** 把当前草稿（html + 规划 + 对话 + 会话 id）持久化到本机，刷新不丢。 */
  saveDraft: () => boolean
  /** 清空，开始一个新的文档会话（同时丢弃已保存草稿）。 */
  reset: () => void

  _delta: (messageId: string, text: string) => void
  _done: (messageId: string, status: string, text: string) => void
  _error: (message: string) => void
}

// 流式缓冲：把本轮 assistant 的增量攒起来，done 时一次性提取规划 / HTML。
const streamBuf = new Map<string, string>()

async function createSession(model: string): Promise<string> {
  // 惰性创建一个隐藏会话（标题固定，避免污染「对话」列表语义）。
  const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
    title: 'HTML 文档草稿',
    model,
  })
  return row.id
}

export const useArtifactStore = create<ArtifactStore>((set, get) => ({
  aggModels: [],
  modelsLoaded: false,
  currentModel: '',
  currentProviderId: null,

  sessionId: initialDraft?.sessionId ?? null,
  turns: initialDraft?.turns ?? [],
  stage: inferStage(initialPlan, initialHtml),
  plan: initialPlan,
  html: initialHtml,
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
    const { stage, streaming } = get()
    if (streaming) return
    const model = get().currentModel
    if (!model) {
      set({ error: '尚未选择模型' })
      return
    }
    const providerId = get().currentProviderId

    let sessionId = get().sessionId
    if (!sessionId) {
      try {
        sessionId = await createSession(model)
        set({ sessionId })
      } catch (e) {
        set({ error: `创建会话失败：${String(e)}` })
        return
      }
    }
    const sid = sessionId

    // 按阶段路由（system 约束前置到用户消息里——后端只存 user/assistant 两种
    // 角色，把强约束塞进 user 文本即可让任何 OpenAI 兼容 relay 生效）。
    let userContent: string
    let nextStage: ArtifactStage
    if (stage === 'idle' || stage === 'planning') {
      // 阶段一：先出规划，不出 HTML。
      userContent = `${ARTIFACT_PLAN_PROMPT}\n\n———\n用户需求：${text}`
      nextStage = 'planning'
    } else if (stage === 'plan_ready') {
      // 阶段二：修订规划。把当前规划（可能已被用户手工编辑）一并发给模型。
      const plan = get().plan.trim()
      userContent =
        `当前规划如下（用户可能已手工编辑过）：\n\n${plan}\n\n———\n` +
        `修改要求：${text}\n\n请输出修订后的**完整规划**（markdown），仍然禁止输出 HTML。`
      nextStage = 'planning'
    } else {
      // done：改已生成的 HTML（沿用原有单轮修改语义）。
      userContent = text
      nextStage = 'generating'
    }

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
      stage: nextStage,
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

  confirmPlan: async () => {
    if (!isTauri) return
    const { stage, streaming, plan } = get()
    if (streaming || stage !== 'plan_ready') return
    const finalPlan = plan.trim()
    if (!finalPlan) {
      set({ error: '规划为空——请先生成规划或在面板里填写' })
      return
    }
    const model = get().currentModel
    if (!model) {
      set({ error: '尚未选择模型' })
      return
    }
    const providerId = get().currentProviderId

    let sessionId = get().sessionId
    if (!sessionId) {
      try {
        sessionId = await createSession(model)
        set({ sessionId })
      } catch (e) {
        set({ error: `创建会话失败：${String(e)}` })
        return
      }
    }
    const sid = sessionId

    // 阶段三：最终规划作为强上下文 + 原有 HTML 生成约束。
    const userContent =
      `${ARTIFACT_SYSTEM_PROMPT}\n\n———\n` +
      `以下是经用户确认的最终规划，请严格按照它生成完整的 HTML 文档：\n\n${finalPlan}`

    set((s) => ({
      turns: [...s.turns, { role: 'user', content: '✅ 已确认规划，按此生成' }],
      stage: 'generating',
      streaming: true,
      error: null,
    }))

    try {
      await tauriInvoke<string>('chat_send', {
        sessionId: sid,
        userContent,
        attachments: [],
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

  setPlan: (plan) => set({ plan }),

  setHtml: (html) => set({ html }),

  saveDraft: () => {
    const s = get()
    try {
      const snap: DraftSnapshot = {
        sessionId: s.sessionId,
        turns: s.turns,
        html: s.html,
        plan: s.plan,
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
    set({
      sessionId: null,
      turns: [],
      stage: 'idle',
      plan: '',
      html: '',
      streaming: false,
      error: null,
    })
  },

  _delta: (messageId, text) => {
    streamBuf.set(messageId, (streamBuf.get(messageId) ?? '') + text)
  },

  _done: (messageId, _status, text) => {
    const full = text || streamBuf.get(messageId) || ''
    streamBuf.delete(messageId)
    set((s): Partial<ArtifactStore> => {
      // 规划轮：整段回复即规划文本，进入确认阶段。
      if (s.stage === 'planning') {
        const plan = full.trim()
        const turns: ArtifactTurn[] = [
          ...s.turns,
          { role: 'assistant', content: full, kind: 'plan' },
        ]
        if (plan) {
          return { turns, streaming: false, stage: 'plan_ready', plan }
        }
        return {
          turns,
          streaming: false,
          stage: s.plan ? 'plan_ready' : 'idle',
          error: '模型没有返回规划，请重试',
        }
      }
      // 生成 / 修改轮：提取 HTML。
      const extracted = extractHtml(full)
      const turns: ArtifactTurn[] = [
        ...s.turns,
        { role: 'assistant', content: full, kind: 'html' },
      ]
      if (extracted) {
        return {
          turns,
          streaming: false,
          stage: 'done',
          html: ensureHtmlDocument(extracted),
        }
      }
      // 模型没吐出可用 HTML：保留旧 html；首次生成失败则退回确认阶段可重试。
      return {
        turns,
        streaming: false,
        stage: s.html ? 'done' : s.plan ? 'plan_ready' : 'idle',
        error: s.html
          ? null
          : '模型未返回可用 HTML——可点「按此规划生成」重试',
      }
    })
  },

  _error: (message) => {
    set((s) => ({
      streaming: false,
      error: message,
      // 流式中间态回退到最近的稳定阶段。
      stage:
        s.stage === 'planning'
          ? s.plan
            ? 'plan_ready'
            : 'idle'
          : s.stage === 'generating'
            ? s.html
              ? 'done'
              : s.plan
                ? 'plan_ready'
                : 'idle'
            : s.stage,
    }))
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
