import { create } from 'zustand'
import { useStudioStore, type ChatMessageRow } from './studioStore'
import { useTaskRegistry } from './taskRegistryStore'

// 图像板块状态中心（V2）。
//  1. 收藏 id 集合（localStorage 持久化，仅本机）。
//  2. 提示词工作台（草稿/模型/尺寸/数量）与「参考输入」（图片/文件 chips）都放
//     这里 —— 离开页面再回来完整恢复，参考图的风格分析在后台继续跑。
//  3. 「再加工」标注工作台的当前编辑（工具/笔迹/指令/提交中状态）也在这里，
//     导航不丢；提交走 image_edit 真实后端命令，长任务挂全局 taskRegistry。
//
// 后端能力事实（src-tauri/src/studio.rs 只读核对，2026-07-12）：
//  - image_generate(prompt, model, size, n, provider_id)：纯文生图，无参考图参数；
//  - image_edit(source_media_id, model, prompt, mask_data_url?, annotated_data_url?,
//    provider_id?)：真实图生图，但只接受已有 gen_media 记录（从磁盘读原图），
//    新图作为新记录入库，params_json 记 source_media_id 溯源；
//  - chat_send 附件支持 { kind:"image", data_url } 多模态（build_user_content →
//    image_url parts）。
//  因此：外部参考图无法直接图生图，走多模态 chat 提炼「风格描述」并入提示词
//  （UI 明示该降级路径）；画廊图的再加工走 image_edit 真实链路。

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
  return 'id-' + Math.random().toString(36).slice(2)
}

// ── 收藏（localStorage） ──────────────────────────────────────────────────────

const LS_KEY = 'agentboard.image.favorites'

function loadFavorites(): string[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

function saveFavorites(ids: string[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(ids))
  } catch {
    // 持久化失败（如存储被禁用）时仅保留内存态。
  }
}

// ── 参考输入 ──────────────────────────────────────────────────────────────────

/** 参考区条目上限（图片 + 文件合计）。 */
export const MAX_REFS = 6
/** 单个参考文件在 store 里保留的最大字符数。 */
const MAX_FILE_CHARS_STORE = 4000
/** 单个参考文件并入提示词的最大字符数。 */
const MAX_FILE_CHARS_PROMPT = 800

export interface RefItem {
  id: string
  kind: 'image' | 'file'
  name: string
  /** 图片参考：压缩后的 data URL（也用作 chip 缩略图）。 */
  dataUrl?: string
  /** 文件参考：文本内容（截断存储）。 */
  text?: string
  /** 文件读入时是否被截断。 */
  truncated?: boolean
  /** 图片参考的风格分析状态；文件参考恒为 done。 */
  status: 'analyzing' | 'done' | 'failed'
  /** 图片参考：多模态模型提炼出的风格描述。 */
  styleDesc?: string
  error?: string
}

/** 在途的参考图风格分析任务（模块级，跨页面导航存活）。 */
const analysisJobs = new Map<string, Promise<void>>()

/**
 * 用多模态 chat（chat_send 的 image 附件）提炼参考图风格描述。
 * 走一次性临时会话，取回助手回复后立即删除会话，不污染聊天历史。
 */
async function analyzeImageStyle(dataUrl: string, name: string): Promise<string> {
  const studio = useStudioStore.getState()
  if (!studio.modelsLoaded) await studio.loadModels()
  const chatModels = useStudioStore
    .getState()
    .aggModels.filter((m) => m.kind === 'chat')
  const model =
    chatModels.find((m) => m.modelId === 'gpt-5.5') ?? chatModels[0]
  if (!model) throw new Error('没有可用的多模态对话模型')

  const sessionId = uuid()
  try {
    await tauriInvoke<string>('chat_send', {
      sessionId,
      userContent:
        '请用中文提炼这张参考图的风格要点（构图、色彩、光线、质感、主体特征），' +
        '60~100 字，只输出描述本身，不要任何客套或前后缀。',
      attachments: [{ kind: 'image', name, data_url: dataUrl }],
      model: model.modelId,
      providerId: model.providerId,
    })
    const rows = await tauriInvoke<ChatMessageRow[]>('chat_messages_list', {
      sessionId,
    })
    const reply = [...rows]
      .reverse()
      .find((r) => r.role === 'assistant' && r.content.trim())
    if (!reply) throw new Error('模型未返回风格描述')
    return reply.content.trim()
  } finally {
    // 清理临时会话；失败不影响主流程。
    try {
      await tauriInvoke<void>('chat_sessions_delete', { sessionId })
    } catch {
      /* ignore */
    }
    void useStudioStore.getState().loadSessions()
  }
}

/** 把参考条目并入基础提示词，产出最终生成 prompt。 */
function buildFinalPrompt(base: string, refs: RefItem[]): string {
  const parts: string[] = [base]
  const styleRefs = refs.filter(
    (r) => r.kind === 'image' && r.status === 'done' && r.styleDesc,
  )
  for (const r of styleRefs) {
    parts.push(`【参考图「${r.name}」风格】${r.styleDesc}`)
  }
  const fileRefs = refs.filter((r) => r.kind === 'file' && r.text)
  for (const r of fileRefs) {
    const text = r.text ?? ''
    const cut = text.length > MAX_FILE_CHARS_PROMPT
    const body = cut ? text.slice(0, MAX_FILE_CHARS_PROMPT) : text
    const mark = cut || r.truncated ? '（节选）' : ''
    parts.push(`【参考文件「${r.name}」${mark}】\n${body}`)
  }
  if (styleRefs.length > 0) parts.push('画面需充分呼应上述参考图的风格要点。')
  if (fileRefs.length > 0) parts.push('请依据上述参考文件内容生成图像。')
  return parts.join('\n\n')
}

// ── 再加工（标注）工作台 ──────────────────────────────────────────────────────

export interface AnnoPoint {
  x: number
  y: number
}

export type AnnoOp =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'text'; x: number; y: number; text: string; color: string }
  | { kind: 'brush'; points: AnnoPoint[]; size: number }

export type AnnoTool = 'select' | 'rect' | 'arrow' | 'brush' | 'text'

export interface AnnotatorState {
  /** 被再加工的画廊图（gen_media 记录 id）。 */
  sourceId: string
  tool: AnnoTool
  color: string
  brushSize: number
  ops: AnnoOp[]
  prompt: string
  showPrompt: boolean
  submitting: boolean
  error: string | null
}

export const ANNO_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#84cc16',
  '#3b82f6',
  '#111827',
  '#ffffff',
]

function freshAnnotator(sourceId: string): AnnotatorState {
  return {
    sourceId,
    tool: 'rect',
    color: ANNO_COLORS[0],
    brushSize: 28,
    ops: [],
    prompt: '',
    showPrompt: false,
    submitting: false,
    error: null,
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface ImageStore {
  // 收藏
  favoriteIds: string[]
  toggleFavorite: (id: string) => void
  /** 删除媒体记录时同步清理收藏。 */
  removeFavorite: (id: string) => void

  // 提示词工作台（跨导航保留）
  draft: string
  imageModel: string
  imageProviderId: string
  size: string
  count: number
  setDraft: (v: string) => void
  setImageSel: (providerId: string, modelId: string) => void
  setSize: (v: string) => void
  setCount: (v: number) => void

  // 参考输入
  refs: RefItem[]
  /** 追加图片参考并后台启动风格分析；参考区已满时返回 false。 */
  addImageRef: (name: string, dataUrl: string) => boolean
  /** 追加文本文件参考；参考区已满时返回 false。 */
  addFileRef: (name: string, text: string) => boolean
  removeRef: (id: string) => void

  // 生成
  /** 正在等待参考分析收尾、组装最终 prompt（很短暂）。 */
  assembling: boolean
  /**
   * 组装 prompt 并触发生成（生成本体在后台跑，挂 taskRegistry，导航不丢）。
   * 返回需要 toast 的警告文案（如部分参考图分析失败），无则 null。
   */
  generate: () => Promise<string | null>

  // 再加工
  annotator: AnnotatorState | null
  openAnnotator: (sourceId: string) => void
  closeAnnotator: () => void
  patchAnnotator: (
    patch: Partial<Omit<AnnotatorState, 'sourceId' | 'submitting'>>,
  ) => void
  /** 提交 image_edit；蒙版/合成图由标注画布导出后传入。 */
  submitEdit: (args: {
    maskDataUrl: string | null
    annotatedDataUrl: string | null
  }) => Promise<void>
}

export const useImageStore = create<ImageStore>((set, get) => ({
  favoriteIds: typeof window === 'undefined' ? [] : loadFavorites(),

  toggleFavorite: (id) =>
    set((s) => {
      const ids = s.favoriteIds.includes(id)
        ? s.favoriteIds.filter((x) => x !== id)
        : [...s.favoriteIds, id]
      saveFavorites(ids)
      return { favoriteIds: ids }
    }),

  removeFavorite: (id) =>
    set((s) => {
      if (!s.favoriteIds.includes(id)) return {}
      const ids = s.favoriteIds.filter((x) => x !== id)
      saveFavorites(ids)
      return { favoriteIds: ids }
    }),

  // ── 工作台 ──
  draft: '',
  imageModel: '',
  imageProviderId: '',
  size: '1024x1024',
  count: 1,
  setDraft: (v) => set({ draft: v }),
  setImageSel: (providerId, modelId) =>
    set({ imageProviderId: providerId, imageModel: modelId }),
  setSize: (v) => set({ size: v }),
  setCount: (v) => set({ count: v }),

  // ── 参考输入 ──
  refs: [],

  addImageRef: (name, dataUrl) => {
    if (get().refs.length >= MAX_REFS) return false
    const id = uuid()
    set((s) => ({
      refs: [
        ...s.refs,
        { id, kind: 'image', name, dataUrl, status: 'analyzing' },
      ],
    }))
    const job = analyzeImageStyle(dataUrl, name)
      .then((desc) => {
        set((s) => ({
          refs: s.refs.map((r) =>
            r.id === id ? { ...r, status: 'done' as const, styleDesc: desc } : r,
          ),
        }))
      })
      .catch((e) => {
        set((s) => ({
          refs: s.refs.map((r) =>
            r.id === id
              ? { ...r, status: 'failed' as const, error: String(e) }
              : r,
          ),
        }))
      })
      .finally(() => {
        analysisJobs.delete(id)
      })
    analysisJobs.set(id, job)
    return true
  },

  addFileRef: (name, text) => {
    if (get().refs.length >= MAX_REFS) return false
    const truncated = text.length > MAX_FILE_CHARS_STORE
    set((s) => ({
      refs: [
        ...s.refs,
        {
          id: uuid(),
          kind: 'file',
          name,
          text: truncated ? text.slice(0, MAX_FILE_CHARS_STORE) : text,
          truncated,
          status: 'done',
        },
      ],
    }))
    return true
  },

  removeRef: (id) => set((s) => ({ refs: s.refs.filter((r) => r.id !== id) })),

  // ── 生成 ──
  assembling: false,

  generate: async () => {
    if (!isTauri) return null
    const { draft, imageModel, imageProviderId, size, count, assembling } = get()
    const base = draft.trim()
    if (!base || !imageModel || assembling) return null

    set({ assembling: true })
    let warn: string | null = null
    try {
      // 等未完成的参考图风格分析收尾（失败的照常跳过）。
      if (analysisJobs.size > 0) {
        await Promise.allSettled([...analysisJobs.values()])
      }
      const refs = get().refs
      if (refs.some((r) => r.kind === 'image' && r.status === 'failed')) {
        warn = '部分参考图风格分析失败，已跳过这些参考'
      }
      const prompt = buildFinalPrompt(base, refs)

      const taskId = 'img-gen-' + uuid()
      const reg = useTaskRegistry.getState()
      reg.registerTask({
        id: taskId,
        module: 'image',
        title: `生成图像 ×${count}`,
        detail: base.slice(0, 40),
      })
      const providerId = imageProviderId || null
      // 生成本体后台跑：占位卡由 studio-event 全局监听维护，导航不丢。
      void (async () => {
        await useStudioStore
          .getState()
          .generateImage(prompt, imageModel, size, count, providerId)
        const err = useStudioStore.getState().loadError
        if (err && err.startsWith('图像生成失败')) {
          reg.updateTask(taskId, { status: 'error', detail: err })
        } else {
          reg.updateTask(taskId, { status: 'done' })
        }
      })()
    } finally {
      set({ assembling: false })
    }
    return warn
  },

  // ── 再加工 ──
  annotator: null,

  openAnnotator: (sourceId) =>
    set((s) => {
      // 同一张图重复进入时保留未完成的编辑。
      if (s.annotator && s.annotator.sourceId === sourceId) return {}
      return { annotator: freshAnnotator(sourceId) }
    }),

  closeAnnotator: () => set({ annotator: null }),

  patchAnnotator: (patch) =>
    set((s) => (s.annotator ? { annotator: { ...s.annotator, ...patch } } : {})),

  submitEdit: async ({ maskDataUrl, annotatedDataUrl }) => {
    if (!isTauri) return
    const a = get().annotator
    if (!a || a.submitting) return
    const prompt = a.prompt.trim()
    if (!prompt) return
    const { imageModel, imageProviderId } = get()
    if (!imageModel) {
      set((s) =>
        s.annotator
          ? { annotator: { ...s.annotator, error: '当前没有可用的图像模型' } }
          : {},
      )
      return
    }

    const sourceId = a.sourceId
    set((s) =>
      s.annotator
        ? { annotator: { ...s.annotator, submitting: true, error: null } }
        : {},
    )
    const taskId = 'img-edit-' + uuid()
    const reg = useTaskRegistry.getState()
    reg.registerTask({
      id: taskId,
      module: 'image',
      title: '再加工图像',
      detail: prompt.slice(0, 40),
    })
    try {
      // image_edit 真实签名：source_media_id / model / prompt /
      // mask_data_url? / annotated_data_url? / provider_id?
      await tauriInvoke<string>('image_edit', {
        sourceMediaId: sourceId,
        model: imageModel,
        prompt,
        maskDataUrl: maskDataUrl ?? null,
        annotatedDataUrl: annotatedDataUrl ?? null,
        providerId: imageProviderId || null,
      })
      reg.updateTask(taskId, { status: 'done' })
      // 成功后关闭工作台（若用户已手动关闭/切换则不动）。
      set((s) =>
        s.annotator && s.annotator.sourceId === sourceId
          ? { annotator: null }
          : {},
      )
    } catch (e) {
      reg.updateTask(taskId, { status: 'error', detail: String(e) })
      // 保留工作台与标注内容，允许改指令重试。
      set((s) =>
        s.annotator && s.annotator.sourceId === sourceId
          ? { annotator: { ...s.annotator, submitting: false, error: String(e) } }
          : {},
      )
    } finally {
      void useStudioStore.getState().loadMedia('image')
    }
  },
}))
