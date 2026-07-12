// Artifact store (H3) — 文档/PPT 的 HTML 可视化编辑。
//
// v0.9 起改为「选项驱动」流程（Q3）：
//   阶段一 选项：用户描述需求 → 模型产出一组结构化选项（JSON：类型/风格/
//     篇幅/受众/重点模块…），前端渲染成可勾选控件，带模型推荐的默认值；
//   阶段二 流程：用户勾选完 → 汇总选择让模型产出 workflow（有序步骤流，
//     每步 标题+说明），用户可直接微调步骤文字、增删步骤；
//   阶段三 生成：确认 workflow 后，把「选择汇总 + 步骤流」作为强上下文，
//     让模型生成完整自包含 HTML。
// 状态机：idle → options → options_ready → workflow → workflow_ready
//         → generating → done。
// done 之后继续对话即「改 HTML」轮（内部短暂回到 generating，完成后回 done）。
//
// 复用后端 chat_send（会话+流式，事件名 studio-event）来让模型产出选项 /
// 流程与 HTML。为不与 studioStore 的「当前会话」耦合，这里维护一个**独立**
// 的隐藏会话，并注册自己的 studio-event 监听，只处理本会话的 delta/done/error。
//
// 单一数据源 = `html` 字符串。左栏对话产 HTML → 写入 html；中栏 Monaco 改源码
// → 写入 html；右栏预览可视化编辑 → applyEdit 写回 html。三者始终同步。
// 选项阶段的单一数据源 = `optionGroups` + `selections`；流程阶段 = `workflow`。

import { create } from 'zustand'
import { extractHtml, ensureHtmlDocument } from '../lib/artifactHtml'
import type { AggModel, Attachment } from './studioStore'
import { useTaskRegistry } from './taskRegistryStore'

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

/** 选项驱动流程的阶段状态机。 */
export type ArtifactStage =
  | 'idle'
  | 'options' // 模型正在出选项
  | 'options_ready' // 用户勾选中
  | 'workflow' // 模型正在编排步骤流
  | 'workflow_ready' // 用户确认 / 微调步骤流
  | 'generating'
  | 'done'

/** 一个可勾选的选项。 */
export interface OptionItem {
  id: string
  label: string
  /** 一句话说明（悬停提示）。 */
  desc?: string
}

/** 一组选项（如「风格」「篇幅」），multi 表示是否多选。 */
export interface OptionGroup {
  id: string
  title: string
  multi: boolean
  options: OptionItem[]
  /** 模型推荐的默认选中项（option id 列表）。 */
  defaults?: string[]
}

/** workflow 的一个步骤（可编辑）。 */
export interface WorkflowStep {
  title: string
  detail: string
}

/** 一条对话记录（仅左栏展示用，非 DB 行）。 */
export interface ArtifactTurn {
  role: 'user' | 'assistant'
  content: string
  /** assistant 轮产物类型：options=选项组，workflow=步骤流，html=HTML 文档；
   *  plan 为 v0.9 之前旧草稿的规划轮（仅兼容展示）。 */
  kind?: 'plan' | 'options' | 'workflow' | 'html'
  /** 用户轮附带的参考文件元信息（仅展示名称，内容已并入发送消息）。 */
  attachments?: { kind: string; name?: string }[]
}

// ── 模型输出解析（选项 JSON / workflow JSON） ────────────────────────

/** 从模型回复里提取第一个可解析的 JSON 对象（容忍 ```json 围栏与前后杂文）。 */
function extractJsonObject(text: string): unknown {
  const t = (text ?? '').trim()
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(t)
  for (const c of [fenced?.[1], t]) {
    if (!c) continue
    const s = c.indexOf('{')
    const e = c.lastIndexOf('}')
    if (s < 0 || e <= s) continue
    try {
      return JSON.parse(c.slice(s, e + 1))
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 解析选项组 JSON；结构不合法时返回 null（由调用方给出错误提示重试）。 */
export function parseOptionGroups(text: string): OptionGroup[] | null {
  const root = extractJsonObject(text)
  if (!isRecord(root) || !Array.isArray(root.groups)) return null
  const groups: OptionGroup[] = []
  root.groups.forEach((g, gi) => {
    if (!isRecord(g) || typeof g.title !== 'string' || !Array.isArray(g.options))
      return
    const options: OptionItem[] = []
    g.options.forEach((o, oi) => {
      if (!isRecord(o) || typeof o.label !== 'string' || !o.label.trim()) return
      options.push({
        id: typeof o.id === 'string' && o.id ? o.id : `o${oi}`,
        label: o.label.trim(),
        desc: typeof o.desc === 'string' ? o.desc : undefined,
      })
    })
    if (options.length === 0) return
    const ids = new Set(options.map((o) => o.id))
    const defaults = Array.isArray(g.defaults)
      ? g.defaults.filter((d): d is string => typeof d === 'string' && ids.has(d))
      : []
    groups.push({
      id: typeof g.id === 'string' && g.id ? g.id : `g${gi}`,
      title: g.title.trim(),
      multi: !!g.multi,
      options,
      defaults,
    })
  })
  return groups.length > 0 ? groups : null
}

/** 解析 workflow 步骤 JSON；结构不合法时返回 null。 */
export function parseWorkflowSteps(text: string): WorkflowStep[] | null {
  const root = extractJsonObject(text)
  if (!isRecord(root) || !Array.isArray(root.steps)) return null
  const steps: WorkflowStep[] = []
  root.steps.forEach((st) => {
    if (!isRecord(st) || typeof st.title !== 'string' || !st.title.trim()) return
    steps.push({
      title: st.title.trim(),
      detail: typeof st.detail === 'string' ? st.detail.trim() : '',
    })
  })
  return steps.length > 0 ? steps : null
}

/** 按模型推荐 defaults 生成初始勾选（单选组无 defaults 时兜底选第一项）。 */
export function defaultSelections(
  groups: OptionGroup[],
): Record<string, string[]> {
  const sel: Record<string, string[]> = {}
  for (const g of groups) {
    const d = (g.defaults ?? []).filter((id) => g.options.some((o) => o.id === id))
    if (g.multi) {
      sel[g.id] = d
    } else {
      sel[g.id] = d.length > 0 ? [d[0]] : g.options[0] ? [g.options[0].id] : []
    }
  }
  return sel
}

/** 把当前勾选汇总成给模型看的中文清单。 */
function buildSelectionSummary(
  groups: OptionGroup[],
  selections: Record<string, string[]>,
): string {
  return groups
    .map((g) => {
      const picked = selections[g.id] ?? []
      const labels = g.options
        .filter((o) => picked.includes(o.id))
        .map((o) => o.label)
      return `- ${g.title}：${labels.length > 0 ? labels.join('、') : '（未选，请自行斟酌）'}`
    })
    .join('\n')
}

/** 把 workflow 步骤序列化成给模型看的编号清单。 */
function buildWorkflowText(steps: WorkflowStep[]): string {
  return steps
    .map((s, i) => `${i + 1}. ${s.title}${s.detail ? `：${s.detail}` : ''}`)
    .join('\n')
}

// ── 草稿持久化（localStorage，刷新/重启不丢） ────────────────────────

const DRAFT_KEY = 'agentboard.artifact.draft.v1'

interface DraftSnapshot {
  sessionId: string | null
  turns: ArtifactTurn[]
  html: string
  savedAt: number
  /** v0.9 早期两阶段流程的规划文本（旧草稿兼容：迁移成单步 workflow）。 */
  plan?: string
  /** 选项驱动流程的持久化字段。 */
  optionGroups?: OptionGroup[]
  selections?: Record<string, string[]>
  workflow?: WorkflowStep[]
}

/** 从产物推断可恢复的阶段（流式中间态 options/workflow/generating 不可恢复）。 */
function inferStage(
  html: string,
  workflow: WorkflowStep[],
  optionGroups: OptionGroup[],
): ArtifactStage {
  if (html) return 'done'
  if (workflow.length > 0) return 'workflow_ready'
  if (optionGroups.length > 0) return 'options_ready'
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
const initialHtml = initialDraft?.html ?? ''
const initialGroups: OptionGroup[] = Array.isArray(initialDraft?.optionGroups)
  ? initialDraft.optionGroups.filter(
      (g) => isRecord(g) && typeof g.title === 'string' && Array.isArray(g.options),
    )
  : []
const initialWorkflow: WorkflowStep[] = Array.isArray(initialDraft?.workflow)
  ? initialDraft.workflow.filter(
      (s) => isRecord(s) && typeof s.title === 'string',
    )
  : // 旧两阶段草稿：把规划文本迁移成单步 workflow，不丢内容。
    typeof initialDraft?.plan === 'string' && initialDraft.plan.trim()
    ? [{ title: '原规划（旧草稿迁移）', detail: initialDraft.plan.trim() }]
    : []
const initialSelections: Record<string, string[]> =
  initialDraft?.selections && isRecord(initialDraft.selections)
    ? (initialDraft.selections as Record<string, string[]>)
    : defaultSelections(initialGroups)

// ── 各阶段 system 提示 ───────────────────────────────────────────────

/** 阶段一：只出结构化选项 JSON，绝不输出规划长文或 HTML。 */
export const ARTIFACT_OPTIONS_PROMPT = `你是「文档 / PPT 需求配置助手」。用户会描述想要的文档或幻灯片，你的任务是产出一组**结构化选项**供用户勾选，**绝对不要**输出成篇的规划文档，也不要输出任何 HTML。
只输出一个 JSON 对象（可以包在 \`\`\`json 代码块里），JSON 之外不要任何文字。格式示例：
{"groups":[{"id":"type","title":"类型","multi":false,"options":[{"id":"ppt","label":"PPT 幻灯片","desc":"整屏分页展示"},{"id":"doc","label":"网页文档","desc":"连续滚动的单页文档"}],"defaults":["ppt"]}]}
要求：
1. 给 4~6 个选项组，必须覆盖：类型（PPT / 网页文档 / 报告 / 海报…）、风格/视觉方向（3~5 个具名风格，如 简约商务 / 科技深色 / 学术严谨 / 活泼多彩）、结构/篇幅（页数或章节数档位）、受众/语气；可再加一个「重点模块」多选组。
2. 每组 3~5 个选项：label 简短（2~8 字），desc 一句话说明；multi 标记该组是否可多选；defaults 给出你推荐的默认选中项（option id 数组，单选组恰好 1 个，多选组可给多个）。
3. 选项要贴合用户的具体需求，具体可选、不要泛泛而谈。全部中文。
4. 之后用户可能要求调整选项：同样只输出**完整的**选项 JSON，格式不变。`

/** 阶段二：按用户勾选产出 workflow 步骤流 JSON。 */
export const ARTIFACT_WORKFLOW_PROMPT = `请根据本会话前面的用户需求，以及下面用户勾选的配置，产出一个**制作流程（workflow）**：把最终文档 / PPT 拆成有序步骤（例如 第1步 封面 → 第2步 目录 → 第3步 各章要点 → … → 末页 结语/CTA），每步一个标题和一句说明。
只输出一个 JSON 对象（可以包在 \`\`\`json 代码块里），JSON 之外不要任何文字。格式示例：
{"steps":[{"title":"第1步 封面（科技深色风）","detail":"主标题、副标题、日期；深色渐变背景 + 高亮主色"},{"title":"第2步 目录","detail":"列出各章节标题，单页居中排版"}]}
要求：5~12 步；覆盖从封面/开头到结尾的完整结构；每步 detail 一句话点明该页/该节的内容与视觉要点，并体现用户勾选的风格。全部中文，禁止输出 HTML。
之后用户可能要求调整流程：同样只输出**完整的**步骤 JSON，格式不变。`

/** 阶段三：强约束 system 提示——只回一个完整、离线、自包含的 HTML 文档。 */
export const ARTIFACT_SYSTEM_PROMPT = `你是一个「文档 / PPT 的 HTML 生成器」。请严格遵守以下规则：
1. 只输出**一个**完整的 HTML 文档，用一个 \`\`\`html 代码块包裹，代码块外不要有任何多余文字、解释或寒暄。
2. 文档必须**自包含、可离线打开**：所有 CSS 内联在 <style> 里，不引用任何外部资源、CDN、字体或图片 URL；不使用 <script>（用纯 HTML+CSS 实现排版与分页）。
3. 若用户要做 PPT / 幻灯片：每一页用 <section class="slide"> 包裹，页与页之间用 CSS 控制为整屏（例如每个 .slide 高度 100vh、居中排版），风格干净专业。
4. 采用蓝白科研风：主色 #2563eb，背景白色，正文用深灰(slate)，字体使用系统无衬线字体栈；若用户配置里给出了其他视觉方向，以用户配置为准。
5. 当用户要求修改时，**返回修改后的完整 HTML 文档**（同样用一个 \`\`\`html 代码块），不要只给片段或 diff。
6. 中文内容，排版整洁，注意留白与层级。`

interface ArtifactStore {
  aggModels: AggModel[]
  modelsLoaded: boolean
  currentModel: string
  currentProviderId: string | null

  sessionId: string | null
  turns: ArtifactTurn[]
  /** 选项驱动状态机：idle → options → options_ready → workflow
   *  → workflow_ready → generating → done。 */
  stage: ArtifactStage
  /** 阶段一产出的选项组（前端渲染成可勾选控件）。 */
  optionGroups: OptionGroup[]
  /** 用户当前勾选：groupId → 选中的 option id 列表。 */
  selections: Record<string, string[]>
  /** 阶段二产出的步骤流（可直接微调 / 增删）。 */
  workflow: WorkflowStep[]
  html: string
  streaming: boolean
  error: string | null

  loadModels: () => Promise<void>
  setModelSel: (providerId: string, modelId: string) => void
  /** 用户提交一段话（可附参考文件）。按阶段路由：
   *  idle → 请求选项；options_ready → 重出选项；workflow_ready → 修订流程；
   *  done → 请求修改 HTML。 */
  ask: (prompt: string, attachments?: Attachment[]) => Promise<void>
  /** 勾选 / 取消一个选项（单选组为切换，多选组为增删）。 */
  toggleOption: (groupId: string, optionId: string) => void
  /** 勾选完毕 → 汇总选择让模型产出 workflow 步骤流。 */
  confirmOptions: () => Promise<void>
  /** 确认步骤流 → 以「选择汇总 + 步骤流」为强上下文生成完整 HTML。 */
  confirmWorkflow: () => Promise<void>
  /** 跳过选项/流程阶段，直接以外部材料（如 PDF 提炼的演讲要点）生成演示稿。
   *  会覆盖当前草稿并开新隐藏会话；完成后进入 done（双栏编辑视图）。 */
  generateFromMaterial: (title: string, material: string) => Promise<void>
  /** 从流程确认页退回选项勾选页（保留已出的 workflow 备用）。 */
  backToOptions: () => void
  /** 直接微调某个步骤的文字（不触发模型）。 */
  setWorkflowStep: (index: number, step: WorkflowStep) => void
  addWorkflowStep: () => void
  removeWorkflowStep: (index: number) => void
  stop: () => Promise<void>
  /** 中栏 Monaco 或可视化编辑直接改 HTML 字符串（不触发模型）。 */
  setHtml: (html: string) => void
  /** 把当前草稿（html + 选项 + 勾选 + 流程 + 对话 + 会话 id）持久化到本机。 */
  saveDraft: () => boolean
  /** 清空，开始一个新的文档会话（同时丢弃已保存草稿）。 */
  reset: () => void

  _delta: (messageId: string, text: string) => void
  _done: (messageId: string, status: string, text: string) => void
  _error: (message: string) => void
}

// 流式缓冲：把本轮 assistant 的增量攒起来，done 时一次性提取选项 / 流程 / HTML。
const streamBuf = new Map<string, string>()

// ── 全局任务条登记（HTML 生成是长任务；办公板块 module='office'） ────

let artifactTaskId: string | null = null

function regArtifactTask(title: string, detail?: string): void {
  artifactTaskId = `office-ppt-${Date.now()}`
  useTaskRegistry
    .getState()
    .registerTask({ id: artifactTaskId, module: 'office', title, detail })
}

function endArtifactTask(ok: boolean, detail?: string): void {
  if (!artifactTaskId) return
  useTaskRegistry
    .getState()
    .updateTask(artifactTaskId, { status: ok ? 'done' : 'error', detail })
  artifactTaskId = null
}

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
  stage: inferStage(initialHtml, initialWorkflow, initialGroups),
  optionGroups: initialGroups,
  selections: initialSelections,
  workflow: initialWorkflow,
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
    if (stage === 'idle' || stage === 'options') {
      // 阶段一：出结构化选项。
      userContent = `${ARTIFACT_OPTIONS_PROMPT}\n\n———\n用户需求：${text}`
      nextStage = 'options'
    } else if (stage === 'options_ready') {
      // 用户对选项不满意：带上当前选项 JSON 重出。
      const cur = JSON.stringify({ groups: get().optionGroups })
      userContent =
        `当前选项组如下（JSON）：\n${cur}\n\n———\n调整要求：${text}\n\n` +
        `请输出调整后的**完整选项 JSON**（格式同前），不要其他文字，禁止输出 HTML。`
      nextStage = 'options'
    } else if (stage === 'workflow_ready' || stage === 'workflow') {
      // 阶段二修订：带上当前步骤流（用户可能已手工微调）。
      const cur = JSON.stringify({ steps: get().workflow })
      userContent =
        `当前制作流程如下（JSON，用户可能已手工微调）：\n${cur}\n\n———\n` +
        `调整要求：${text}\n\n请输出调整后的**完整步骤 JSON**（格式同前），不要其他文字，禁止输出 HTML。`
      nextStage = 'workflow'
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

    if (nextStage === 'generating')
      regArtifactTask('PPT · 修改演示稿', text.slice(0, 40))

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

  toggleOption: (groupId, optionId) => {
    set((s) => {
      const group = s.optionGroups.find((g) => g.id === groupId)
      if (!group || !group.options.some((o) => o.id === optionId)) return s
      const cur = s.selections[groupId] ?? []
      let next: string[]
      if (group.multi) {
        next = cur.includes(optionId)
          ? cur.filter((id) => id !== optionId)
          : [...cur, optionId]
      } else {
        next = [optionId]
      }
      return { selections: { ...s.selections, [groupId]: next } }
    })
  },

  confirmOptions: async () => {
    if (!isTauri) return
    const { stage, streaming, optionGroups, selections } = get()
    if (streaming || stage !== 'options_ready') return
    if (optionGroups.length === 0) {
      set({ error: '还没有可用选项——请先在左侧描述需求' })
      return
    }
    const model = get().currentModel
    if (!model) {
      set({ error: '尚未选择模型' })
      return
    }
    const providerId = get().currentProviderId
    const sid = get().sessionId
    if (!sid) {
      set({ error: '会话丢失——请点「新建」重新开始' })
      return
    }

    const summary = buildSelectionSummary(optionGroups, selections)
    const userContent = `${ARTIFACT_WORKFLOW_PROMPT}\n\n———\n用户勾选的配置：\n${summary}`

    set((s) => ({
      turns: [
        ...s.turns,
        { role: 'user', content: `✅ 已选好配置：\n${summary}` },
      ],
      stage: 'workflow',
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

  confirmWorkflow: async () => {
    if (!isTauri) return
    const { stage, streaming, workflow, optionGroups, selections } = get()
    if (streaming || stage !== 'workflow_ready') return
    const steps = workflow.filter((s) => s.title.trim() || s.detail.trim())
    if (steps.length === 0) {
      set({ error: '流程为空——请先生成流程或添加步骤' })
      return
    }
    const model = get().currentModel
    if (!model) {
      set({ error: '尚未选择模型' })
      return
    }
    const providerId = get().currentProviderId
    const sid = get().sessionId
    if (!sid) {
      set({ error: '会话丢失——请点「新建」重新开始' })
      return
    }

    // 阶段三：选择汇总 + 最终步骤流 作为强上下文 + 原有 HTML 生成约束。
    const summary =
      optionGroups.length > 0
        ? buildSelectionSummary(optionGroups, selections)
        : '（无——按流程与会话上下文自行斟酌）'
    const userContent =
      `${ARTIFACT_SYSTEM_PROMPT}\n\n———\n` +
      `以下是经用户确认的配置与制作流程，请严格按照它们生成完整的 HTML 文档：\n\n` +
      `【用户配置】\n${summary}\n\n【制作流程】\n${buildWorkflowText(steps)}`

    set((s) => ({
      turns: [...s.turns, { role: 'user', content: '✅ 已确认流程，按此生成' }],
      stage: 'generating',
      streaming: true,
      error: null,
    }))
    regArtifactTask('PPT · 生成演示稿', `${steps.length} 步流程`)

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

  generateFromMaterial: async (title, material) => {
    if (!isTauri) return
    if (get().streaming) throw new Error('PPT 窗口正在生成中，请稍后再试')
    await initArtifactEventListener()
    if (!get().modelsLoaded) {
      await get().loadModels()
      // 与 PPT 窗口一致：默认优先 gpt-5.5。
      const st = get()
      const preferred = st.aggModels.find((m) => m.modelId === 'gpt-5.5')
      if (preferred) st.setModelSel(preferred.providerId, preferred.modelId)
    }
    const model = get().currentModel
    if (!model) throw new Error('PPT 引擎尚无可用模型')
    const providerId = get().currentProviderId

    // 覆盖当前草稿，开全新会话（外部材料与旧上下文无关）。
    streamBuf.clear()
    clearDraft()
    const sessionId = await createSession(model)
    set({
      sessionId,
      turns: [{ role: 'user', content: `📄 ${title}\n\n${material}` }],
      stage: 'generating',
      optionGroups: [],
      selections: {},
      workflow: [],
      html: '',
      streaming: true,
      error: null,
    })
    regArtifactTask('PPT · 由 PDF 材料生成', title.slice(0, 40))

    const userContent =
      `${ARTIFACT_SYSTEM_PROMPT}\n\n———\n` +
      `请根据下面的演讲要点大纲，生成一份**演讲用 HTML 幻灯片**（每页一个 ` +
      `<section class="slide">，含封面、目录与结尾页；要点短句化、可直接放映）：\n\n` +
      `【演讲主题】${title}\n\n【要点大纲】\n${material}`
    try {
      await tauriInvoke<string>('chat_send', {
        sessionId,
        userContent,
        attachments: [],
        model,
        providerId: providerId ?? null,
      })
    } catch (e) {
      get()._error(String(e))
      throw e instanceof Error ? e : new Error(String(e))
    }
  },

  backToOptions: () => {
    const { stage, streaming, optionGroups } = get()
    if (streaming || stage !== 'workflow_ready') return
    if (optionGroups.length === 0) return
    set({ stage: 'options_ready' })
  },

  setWorkflowStep: (index, step) => {
    set((s) => ({
      workflow: s.workflow.map((st, i) => (i === index ? step : st)),
    }))
  },

  addWorkflowStep: () => {
    set((s) => ({
      workflow: [
        ...s.workflow,
        { title: `第${s.workflow.length + 1}步 `, detail: '' },
      ],
    }))
  },

  removeWorkflowStep: (index) => {
    set((s) => ({ workflow: s.workflow.filter((_, i) => i !== index) }))
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
        optionGroups: s.optionGroups,
        selections: s.selections,
        workflow: s.workflow,
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
      optionGroups: [],
      selections: {},
      workflow: [],
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
      // 选项轮：解析选项 JSON，进入勾选阶段（默认值 = 模型推荐）。
      if (s.stage === 'options') {
        const groups = parseOptionGroups(full)
        const turns: ArtifactTurn[] = [
          ...s.turns,
          { role: 'assistant', content: full, kind: 'options' },
        ]
        if (groups) {
          return {
            turns,
            streaming: false,
            stage: 'options_ready',
            optionGroups: groups,
            selections: defaultSelections(groups),
          }
        }
        return {
          turns,
          streaming: false,
          stage: s.optionGroups.length > 0 ? 'options_ready' : 'idle',
          error: '模型没有返回有效的选项 JSON，请重试或换个模型',
        }
      }
      // 流程轮：解析步骤 JSON，进入确认 / 微调阶段。
      if (s.stage === 'workflow') {
        const steps = parseWorkflowSteps(full)
        const turns: ArtifactTurn[] = [
          ...s.turns,
          { role: 'assistant', content: full, kind: 'workflow' },
        ]
        if (steps) {
          return {
            turns,
            streaming: false,
            stage: 'workflow_ready',
            workflow: steps,
          }
        }
        return {
          turns,
          streaming: false,
          stage: s.workflow.length > 0 ? 'workflow_ready' : 'options_ready',
          error: '模型没有返回有效的流程 JSON，请重试或换个模型',
        }
      }
      // 生成 / 修改轮：提取 HTML。
      const extracted = extractHtml(full)
      const turns: ArtifactTurn[] = [
        ...s.turns,
        { role: 'assistant', content: full, kind: 'html' },
      ]
      if (extracted) {
        endArtifactTask(true)
        return {
          turns,
          streaming: false,
          stage: 'done',
          html: ensureHtmlDocument(extracted),
        }
      }
      endArtifactTask(false, '模型未返回可用 HTML')
      // 模型没吐出可用 HTML：保留旧 html；首次生成失败则退回确认阶段可重试。
      return {
        turns,
        streaming: false,
        stage: s.html
          ? 'done'
          : s.workflow.length > 0
            ? 'workflow_ready'
            : s.optionGroups.length > 0
              ? 'options_ready'
              : 'idle',
        error: s.html
          ? null
          : '模型未返回可用 HTML——可点「按此流程生成」重试',
      }
    })
  },

  _error: (message) => {
    endArtifactTask(false, message.slice(0, 60))
    set((s) => ({
      streaming: false,
      error: message,
      // 流式中间态回退到最近的稳定阶段。
      stage:
        s.stage === 'options'
          ? s.optionGroups.length > 0
            ? 'options_ready'
            : 'idle'
          : s.stage === 'workflow'
            ? s.workflow.length > 0
              ? 'workflow_ready'
              : s.optionGroups.length > 0
                ? 'options_ready'
                : 'idle'
            : s.stage === 'generating'
              ? s.html
                ? 'done'
                : s.workflow.length > 0
                  ? 'workflow_ready'
                  : s.optionGroups.length > 0
                    ? 'options_ready'
                    : 'idle'
              : s.stage,
    }))
  },
}))

// ── 草稿自动持久化（阶段态全量恢复：options/workflow/done 都能还原） ──
// 流式增量只写 streamBuf（非 store），不会触发订阅；其余变化防抖落盘。
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
useArtifactStore.subscribe(() => {
  if (draftSaveTimer != null) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null
    useArtifactStore.getState().saveDraft()
  }, 800)
})

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
