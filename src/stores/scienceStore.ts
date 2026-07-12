// 科研板块全局状态 —— 文献分析工作台 + idea 思考 + 页内 tab 路由。
//
// 设计要点:
// - 分析会话 / idea 对话 / 进行中任务全部放在本 store(模块级 zustand),切页不丢;
//   高亮另持久化到 localStorage,应用重启也不丢。
// - 模型调用复用后端 chat 通道(chat_sessions_create + chat_send,事件 studio-event),
//   与 officeStore 相同的封装模式,但支持多会话并发(按 session_id 分发 delta/done)。
// - 长任务(分析报告生成 / idea 生成)登记到 taskRegistryStore(module: 'science')。
import { create } from 'zustand'
import { useTaskRegistry } from './taskRegistryStore'
import { useKbStore, type Paper } from './kbStore'
import type { LitPaper } from './researchStore'

const NL = String.fromCharCode(10)

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

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type SciTab = 'lit' | 'analysis' | 'library' | 'ideas'

/** 文献分析工作台里的一篇论文(可来自文献搜索勾选或知识库条目)。 */
export interface SciPaperRef {
  /** 'kb:<paperId>' 或 'lit:<source>:<id>' */
  key: string
  /** 知识库论文 id;纯搜索结果(未入库)为 null。 */
  kbId: string | null
  title: string
  authors: string
  year: number | null
  venue: string
  abstract: string
  /** 原文外链('' = 无)。 */
  url: string
  doi: string
  filePath: string | null
  /** true = 知识库里有本地 PDF,可预览/划线/提取全文。 */
  isPdf: boolean
  notes: string | null
}

export interface SciHighlightRect {
  x: number
  y: number
  w: number
  h: number
}

/** PDF 划线高亮:页码 + 选中文本 + 颜色 + 归一化矩形(相对页宽高 0..1)。 */
export interface SciHighlight {
  id: string
  page: number
  text: string
  color: string
  rects: SciHighlightRect[]
  createdAt: number
}

export interface SciChatMsg {
  role: 'user' | 'assistant'
  content: string
}

export interface SciChat {
  sessionId: string | null
  messages: SciChatMsg[]
  streaming: boolean
  streamText: string
  error: string | null
}

export interface SciFulltext {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  text: string
  /** 资料级别说明(诚实标注:PDF 提取 / 条目文本 / 仅元数据摘要)。 */
  note: string
}

export interface SciReport {
  md: string
  generating: boolean
  savedPath: string | null
  error: string | null
}

// ── 常量与小工具 ─────────────────────────────────────────────────────────────

const FULLTEXT_CHAR_CAP = 60000
const PDF_TEXT_PAGE_CAP = 80
const HL_STORAGE_KEY = 'agentboard.science.highlights.v1'

export function kbKey(id: string): string {
  return 'kb:' + id
}

function litKey(p: LitPaper): string {
  return 'lit:' + p.source + ':' + p.id
}

/** Windows 安全文件名 stem:去非法字符、压缩空白、限长。 */
export function safeFileStem(title: string, year: number | null): string {
  const base = (year ? year + '_' : '') + title
  return (
    base
      .replace(/[/:*?"<>|\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled'
  )
}

function nowStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

/** 从知识库 notes 里恢复「原文链接: <url>」(文献搜索一键入库写入的格式)。 */
function urlFromNotes(notes: string | null): string {
  if (!notes) return ''
  const idx = notes.indexOf('原文链接:')
  if (idx < 0) return ''
  const rest = notes.slice(idx + 5).trim()
  const end = rest.search(/\s/)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

function isTextEntryPath(p: string | null): boolean {
  if (!p) return false
  const low = p.toLowerCase()
  return low.endsWith('.md') || low.endsWith('.markdown') || low.endsWith('.txt')
}

function loadStoredHighlights(): Record<string, SciHighlight[]> {
  try {
    const raw = localStorage.getItem(HL_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, SciHighlight[]>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveStoredHighlights(hl: Record<string, SciHighlight[]>) {
  try {
    localStorage.setItem(HL_STORAGE_KEY, JSON.stringify(hl))
  } catch {
    /* storage full / unavailable — 高亮仍在内存 store 里 */
  }
}

// ── chat 通道(多会话并发,studio-event 分发) ────────────────────────────────

interface PendingRun {
  resolve: (text: string) => void
  reject: (err: Error) => void
}

type DeltaTarget =
  | { kind: 'paper'; key: string }
  | { kind: 'report'; key: string }
  | { kind: 'idea' }

const pendingRuns = new Map<string, PendingRun>()
const sessionTargets = new Map<string, DeltaTarget>()
let listenerReady = false

interface StudioEvent {
  type: string
  session_id?: string
  text?: string
  message?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost?: number
}

async function ensureListener(): Promise<void> {
  if (listenerReady || !isTauri) return
  listenerReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const buffers = new Map<string, string>()
    await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      const sid = p.session_id
      if (!sid || !pendingRuns.has(sid)) return
      if (p.type === 'delta') {
        const buf = (buffers.get(sid) ?? '') + (p.text ?? '')
        buffers.set(sid, buf)
        dispatchDelta(sid, buf)
      } else if (p.type === 'done') {
        const run = pendingRuns.get(sid)
        pendingRuns.delete(sid)
        const finalText = p.text || buffers.get(sid) || ''
        buffers.delete(sid)
        // 用量落库：done 事件若带 usage 字段，写入 pi_usage 表统一统计。
        if (p.input_tokens || p.output_tokens) {
          const model = (useScienceStore.getState().modelKey.split('|')[1] ?? 'unknown')
          void tauriInvoke<void>('pi_usage_insert_manual', {
            sessionId: sid,
            model: 'science:' + model,
            provider: 'studio',
            input: p.input_tokens ?? 0,
            output: p.output_tokens ?? 0,
            cacheRead: p.cache_read_tokens ?? 0,
            cacheWrite: p.cache_write_tokens ?? 0,
            cost: p.cost ?? 0,
          }).catch(() => {})
        }
        run?.resolve(finalText)
      } else if (p.type === 'error') {
        const run = pendingRuns.get(sid)
        pendingRuns.delete(sid)
        buffers.delete(sid)
        run?.reject(new Error(p.message ?? '生成出错'))
      }
    })
  } catch (err) {
    listenerReady = false
    console.warn('[scienceStore] studio-event listener failed:', err)
  }
}

/** 单轮模型调用:等 done/error;delta 由 dispatchDelta 派发到对应 UI 区域。 */
async function runChatTurn(
  sessionId: string,
  model: string,
  providerId: string | null,
  userContent: string,
): Promise<string> {
  if (!isTauri) throw new Error('模型调用仅在桌面应用内可用')
  await ensureListener()
  const promise = new Promise<string>((resolve, reject) => {
    pendingRuns.set(sessionId, { resolve, reject })
  })
  try {
    await tauriInvoke<string>('chat_send', {
      sessionId,
      userContent,
      attachments: [],
      model,
      providerId,
    })
  } catch (e) {
    // invoke 抛错时事件流可能已 reject 过;吞掉孤儿 promise 的 rejection。
    promise.catch(() => {})
    pendingRuns.delete(sessionId)
    throw e instanceof Error ? e : new Error(String(e))
  }
  return promise
}

async function createChatSession(title: string, model: string): Promise<string> {
  const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
    title,
    model,
  })
  return row.id
}

function parseModelKey(modelKey: string): { providerId: string; model: string } | null {
  const sep = modelKey.indexOf('|')
  if (sep < 0) return null
  return { providerId: modelKey.slice(0, sep), model: modelKey.slice(sep + 1) }
}

// ── 全文提取(pdfjs / kb_read_bytes) ─────────────────────────────────────────

async function kbReadBytes(paperId: string, which?: string): Promise<Uint8Array> {
  const res = await tauriInvoke<{ base64: string; size: number }>('kb_read_bytes', {
    id: paperId,
    which: which ?? null,
  })
  const bin = atob(res.base64)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  return data
}

export async function kbReadText(paperId: string, which?: string): Promise<string> {
  const data = await kbReadBytes(paperId, which)
  return new TextDecoder('utf-8').decode(data)
}

/** 用 pdfjs 提取本地 PDF 文本(前 PDF_TEXT_PAGE_CAP 页,截断 FULLTEXT_CHAR_CAP)。 */
async function extractPdfText(paperId: string): Promise<string> {
  const [pdfjs, workerMod] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default
  }
  const data = await kbReadBytes(paperId)
  const doc = await pdfjs.getDocument({ data }).promise
  try {
    const pages = Math.min(doc.numPages, PDF_TEXT_PAGE_CAP)
    let out = ''
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n)
      const tc = await page.getTextContent()
      out += tc.items.map((it) => ('str' in it ? it.str : '')).join(' ') + NL
      if (out.length > FULLTEXT_CHAR_CAP) break
    }
    return out.slice(0, FULLTEXT_CHAR_CAP)
  } finally {
    void doc.loadingTask.destroy()
  }
}

function buildMetaText(ref: SciPaperRef): string {
  const lines: string[] = []
  lines.push('标题: ' + ref.title)
  if (ref.authors) lines.push('作者: ' + ref.authors)
  if (ref.year) lines.push('年份: ' + ref.year)
  if (ref.venue) lines.push('来源: ' + ref.venue)
  if (ref.doi) lines.push('DOI: ' + ref.doi)
  if (ref.url) lines.push('原文链接: ' + ref.url)
  if (ref.abstract) {
    lines.push('')
    lines.push('摘要:')
    lines.push(ref.abstract)
  }
  if (ref.notes) {
    lines.push('')
    lines.push('我的笔记:')
    lines.push(ref.notes)
  }
  return lines.join(NL)
}

function buildContextPreamble(ref: SciPaperRef, ft: SciFulltext): string {
  return (
    '你是严谨的文献分析助手。以下是一篇论文的资料,后续所有问题都针对这篇论文。' +
    '回答要具体、给出依据;资料里没有的信息请明确说明「原文资料未提供」,不要编造。' +
    NL + NL +
    '标题: ' + ref.title + NL +
    (ref.authors ? '作者: ' + ref.authors + NL : '') +
    (ref.year ? '年份: ' + ref.year + NL : '') +
    (ref.venue ? '来源: ' + ref.venue + NL : '') +
    (ref.doi ? 'DOI: ' + ref.doi + NL : '') +
    '资料级别: ' + ft.note + NL + NL +
    '--- 论文资料开始 ---' + NL +
    ft.text + NL +
    '--- 论文资料结束 ---'
  )
}

function paperRefFromKb(p: Paper): SciPaperRef {
  const fp = p.file_path ?? null
  return {
    key: kbKey(p.id),
    kbId: p.id,
    title: p.title || p.orig_filename || '无标题',
    authors: p.authors ?? '',
    year: p.year,
    venue: p.venue ?? '',
    abstract: p.abstract ?? '',
    url: urlFromNotes(p.notes),
    doi: p.doi ?? '',
    filePath: fp,
    isPdf: !!fp && fp.toLowerCase().endsWith('.pdf'),
    notes: p.notes ?? null,
  }
}

function paperRefFromLit(p: LitPaper): SciPaperRef {
  const year = parseInt(p.year, 10)
  return {
    key: litKey(p),
    kbId: null,
    title: p.title,
    authors: p.authors.join(', '),
    year: Number.isFinite(year) ? year : null,
    venue: p.venue,
    abstract: p.abstract,
    url: p.url,
    doi: p.doi,
    filePath: null,
    isPdf: false,
    notes: null,
  }
}

function emptyChat(): SciChat {
  return { sessionId: null, messages: [], streaming: false, streamText: '', error: null }
}

/** 未入库论文同步报告前先生成的「元数据 + 链接」.md 条目内容。 */
function paperStubMarkdown(ref: SciPaperRef): string {
  const lines: string[] = []
  lines.push('# ' + ref.title)
  lines.push('')
  if (ref.authors) lines.push('- 作者: ' + ref.authors)
  if (ref.year) lines.push('- 年份: ' + ref.year)
  if (ref.venue) lines.push('- 来源: ' + ref.venue)
  if (ref.doi) lines.push('- DOI: ' + ref.doi)
  if (ref.url) lines.push('- 原文链接: <' + ref.url + '>')
  if (ref.abstract) {
    lines.push('')
    lines.push('## 摘要')
    lines.push('')
    lines.push(ref.abstract)
  }
  lines.push('')
  lines.push('> 该条目由「文献分析」同步知识库时生成:仅元数据与链接,下载 PDF 后可在知识库补入正文。')
  lines.push('')
  return lines.join(NL)
}

// ── Store ────────────────────────────────────────────────────────────────────

interface ScienceStore {
  // 页内 tab(放 store:切页/后台返回时不丢)
  activeTab: SciTab
  setActiveTab: (t: SciTab) => void

  // 模型选择('providerId|modelId',列表由 workbenchStore.aggModels 提供)
  modelKey: string
  setModelKey: (k: string) => void

  // ── 文献分析工作台 ──
  analysisPapers: SciPaperRef[]
  currentKey: string | null
  fulltexts: Record<string, SciFulltext>
  chats: Record<string, SciChat>
  reports: Record<string, SciReport>
  highlights: Record<string, SciHighlight[]>

  enterAnalysisFromLit: (papers: LitPaper[]) => void
  enterAnalysisFromKb: (ids: string[]) => Promise<void>
  removeAnalysisPaper: (key: string) => void
  setCurrentPaper: (key: string | null) => void

  ensureFulltext: (key: string) => Promise<SciFulltext>
  ask: (key: string, question: string) => Promise<void>
  stopChat: (key: string) => Promise<void>
  generateReport: (key: string) => Promise<void>
  syncReportToKb: (key: string) => Promise<void>

  addHighlight: (key: string, h: Omit<SciHighlight, 'id' | 'createdAt'>) => void
  removeHighlight: (key: string, id: string) => void

  // ── idea 思考 ──
  ideaSessionId: string | null
  ideaMd: string
  ideaGenerating: boolean
  ideaSavedPath: string | null
  ideaError: string | null
  ideaMessages: SciChatMsg[]
  ideaStreaming: boolean
  ideaStreamText: string
  generateIdeas: (paperIds: string[], instruction: string) => Promise<void>
  ideaAsk: (question: string) => Promise<void>
  resetIdea: () => void
}

function patchChat(key: string, patch: Partial<SciChat>) {
  useScienceStore.setState((s) => ({
    chats: { ...s.chats, [key]: { ...(s.chats[key] ?? emptyChat()), ...patch } },
  }))
}

function patchReport(key: string, patch: Partial<SciReport>) {
  useScienceStore.setState((s) => {
    const cur = s.reports[key] ?? { md: '', generating: false, savedPath: null, error: null }
    return { reports: { ...s.reports, [key]: { ...cur, ...patch } } }
  })
}

export const useScienceStore = create<ScienceStore>((set, get) => ({
  activeTab: 'lit',
  setActiveTab: (t) => set({ activeTab: t }),

  modelKey: '',
  setModelKey: (k) => set({ modelKey: k }),

  analysisPapers: [],
  currentKey: null,
  fulltexts: {},
  chats: {},
  reports: {},
  highlights: loadStoredHighlights(),

  enterAnalysisFromLit: (papers) => {
    if (papers.length === 0) return
    set((s) => {
      const existing = new Set(s.analysisPapers.map((r) => r.key))
      const incoming = papers.map(paperRefFromLit).filter((r) => !existing.has(r.key))
      return {
        analysisPapers: [...s.analysisPapers, ...incoming],
        currentKey: incoming[0]?.key ?? litKey(papers[0]),
        activeTab: 'analysis',
      }
    })
  },

  enterAnalysisFromKb: async (ids) => {
    if (ids.length === 0) return
    const existing = new Set(get().analysisPapers.map((r) => r.key))
    const incoming: SciPaperRef[] = []
    for (const id of ids) {
      if (existing.has(kbKey(id))) continue
      try {
        const p = await tauriInvoke<Paper | null>('kb_get_paper', { id })
        if (p) incoming.push(paperRefFromKb(p))
      } catch (e) {
        console.warn('[scienceStore] kb_get_paper failed:', e)
      }
    }
    set((s) => ({
      analysisPapers: [...s.analysisPapers, ...incoming],
      currentKey: incoming[0]?.key ?? kbKey(ids[0]),
      activeTab: 'analysis',
    }))
  },

  removeAnalysisPaper: (key) => {
    set((s) => {
      const rest = s.analysisPapers.filter((r) => r.key !== key)
      return {
        analysisPapers: rest,
        currentKey: s.currentKey === key ? rest[0]?.key ?? null : s.currentKey,
      }
    })
  },

  setCurrentPaper: (key) => set({ currentKey: key }),

  ensureFulltext: async (key) => {
    const cur = get().fulltexts[key]
    if (cur && (cur.status === 'ready' || cur.status === 'loading')) return cur
    const ref = get().analysisPapers.find((r) => r.key === key)
    if (!ref) {
      const failed: SciFulltext = { status: 'failed', text: '', note: '论文不在工作台中' }
      return failed
    }
    const setEntry = (entry: SciFulltext) =>
      set((s) => ({ fulltexts: { ...s.fulltexts, [key]: entry } }))

    setEntry({ status: 'loading', text: '', note: '提取中…' })
    try {
      let entry: SciFulltext
      if (ref.kbId && ref.isPdf) {
        const text = await extractPdfText(ref.kbId)
        entry = {
          status: 'ready',
          text,
          note: '本地 PDF 全文(pdfjs 文本提取,前 ' + PDF_TEXT_PAGE_CAP + ' 页内)',
        }
      } else if (ref.kbId && isTextEntryPath(ref.filePath)) {
        const text = (await kbReadText(ref.kbId)).slice(0, FULLTEXT_CHAR_CAP)
        entry = { status: 'ready', text, note: '知识库条目文本(元数据 + 摘要,无 PDF 正文)' }
      } else {
        entry = {
          status: 'ready',
          text: buildMetaText(ref),
          note: '仅元数据/摘要(无本地 PDF;下载后可在知识库补入再重新分析)',
        }
      }
      setEntry(entry)
      return entry
    } catch (e) {
      const entry: SciFulltext = {
        status: 'failed',
        text: buildMetaText(ref),
        note: '正文提取失败,退化为元数据/摘要(' + String(e) + ')',
      }
      setEntry(entry)
      return entry
    }
  },

  ask: async (key, question) => {
    const q = question.trim()
    if (!q) return
    const chat = get().chats[key] ?? emptyChat()
    if (chat.streaming) return
    const ref = get().analysisPapers.find((r) => r.key === key)
    if (!ref) return
    const sel = parseModelKey(get().modelKey)
    if (!sel) {
      patchChat(key, { error: '尚未选择模型(请先在「设置」添加 OpenAI 兼容服务商)' })
      return
    }
    patchChat(key, {
      messages: [...chat.messages, { role: 'user', content: q }],
      streaming: true,
      streamText: '',
      error: null,
    })
    try {
      const ft = await get().ensureFulltext(key)
      let sessionId = get().chats[key]?.sessionId ?? null
      let content = q
      if (!sessionId) {
        sessionId = await createChatSession('文献分析 · ' + ref.title.slice(0, 40), sel.model)
        sessionTargets.set(sessionId, { kind: 'paper', key })
        patchChat(key, { sessionId })
        content = buildContextPreamble(ref, ft) + NL + NL + '我的问题: ' + q
      }
      const reply = await runChatTurn(sessionId, sel.model, sel.providerId, content)
      const after = get().chats[key] ?? emptyChat()
      patchChat(key, {
        messages: [...after.messages, { role: 'assistant', content: reply }],
        streaming: false,
        streamText: '',
      })
    } catch (e) {
      patchChat(key, { streaming: false, streamText: '', error: '提问失败: ' + String(e) })
    }
  },

  stopChat: async (key) => {
    const sid = get().chats[key]?.sessionId
    if (!sid) return
    try {
      await tauriInvoke<void>('chat_stop', { sessionId: sid })
    } catch (e) {
      console.warn('[scienceStore] chat_stop failed:', e)
    }
  },

  generateReport: async (key) => {
    const ref = get().analysisPapers.find((r) => r.key === key)
    if (!ref) return
    if (get().reports[key]?.generating) return
    const sel = parseModelKey(get().modelKey)
    if (!sel) {
      patchReport(key, { error: '尚未选择模型' })
      return
    }
    const taskId = 'sci-report-' + key
    const registry = useTaskRegistry.getState()
    registry.registerTask({
      id: taskId,
      module: 'science',
      title: '分析报告 · ' + ref.title.slice(0, 30),
      detail: '生成中',
    })
    patchReport(key, { md: '', generating: true, error: null })
    try {
      const ft = await get().ensureFulltext(key)
      const hls = get().highlights[key] ?? []
      const chat = get().chats[key]
      const hlBlock =
        hls.length > 0
          ? hls.map((h) => '- [第 ' + h.page + ' 页] ' + h.text).join(NL)
          : '(无)'
      const qaBlock =
        chat && chat.messages.length > 0
          ? chat.messages
              .map((m) => (m.role === 'user' ? '问: ' : '答: ') + m.content)
              .join(NL + NL)
          : '(无)'
      const prompt =
        '请基于以下资料,为这篇论文撰写一份详细的 Markdown 分析报告。直接输出 Markdown 正文(不要外层代码围栏),结构固定为:' + NL +
        '# ' + ref.title + ' — 分析报告' + NL +
        '## 背景与动机' + NL +
        '## 方法' + NL +
        '## 主要贡献与结果' + NL +
        '## 与我的关注点的结合(高亮与问答)' + NL +
        '## 局限与后续方向' + NL + NL +
        '「与我的关注点的结合」一节必须逐条回应下面我的高亮片段和问答记录;若两者皆为(无),该节改为对读者最该关注之处的提示。资料没有的信息写「原文资料未提供」,不要编造。' + NL + NL +
        buildContextPreamble(ref, ft) + NL + NL +
        '--- 我的高亮片段 ---' + NL + hlBlock + NL + NL +
        '--- 我的问答记录 ---' + NL + qaBlock
      const sessionId = await createChatSession('分析报告 · ' + ref.title.slice(0, 40), sel.model)
      sessionTargets.set(sessionId, { kind: 'report', key })
      const md = await runChatTurn(sessionId, sel.model, sel.providerId, prompt)
      patchReport(key, { md, generating: false })
      registry.updateTask(taskId, { status: 'done', detail: '报告已生成' })
    } catch (e) {
      patchReport(key, { generating: false, error: '报告生成失败: ' + String(e) })
      useTaskRegistry.getState().updateTask(taskId, { status: 'error', detail: String(e) })
    }
  },

  syncReportToKb: async (key) => {
    const ref = get().analysisPapers.find((r) => r.key === key)
    const report = get().reports[key]
    if (!ref || !report || !report.md.trim()) return
    try {
      const root = (await tauriInvoke<string>('kb_root_get')).replace(/[/\\]+$/, '')
      const stem = safeFileStem(ref.title, ref.year)

      // ① 未入库的搜索结果:先生成「元数据 + 链接」条目并登记(index 模式)。
      let kbId = ref.kbId
      if (!kbId) {
        const stubPath = root + '/lit-inbox/' + stem + '.md'
        await tauriInvoke<void>('export_text_file', {
          path: stubPath,
          content: paperStubMarkdown(ref),
        })
        kbId = await tauriInvoke<string>('kb_upload_paper', {
          srcPath: stubPath,
          mode: 'index',
          categoryId: null,
        })
        await useKbStore.getState().updateMetadata(kbId, {
          title: ref.title || null,
          authors: ref.authors || null,
          year: ref.year,
          venue: ref.venue || null,
          doi: ref.doi || null,
          notes: ref.url ? '原文链接: ' + ref.url : null,
        })
        set((s) => ({
          analysisPapers: s.analysisPapers.map((r) =>
            r.key === key ? { ...r, kbId } : r,
          ),
        }))
      }

      // ② 报告写入 kb_root/analysis/,并回写 analyzed / analysis_md_path。
      const mdPath = root + '/analysis/' + stem + '.md'
      await tauriInvoke<void>('export_text_file', { path: mdPath, content: report.md })
      await useKbStore.getState().updateMetadata(kbId, {
        year: ref.year,
        analyzed: true,
        analysisMdPath: mdPath,
      })
      patchReport(key, { savedPath: mdPath, error: null })
      void useKbStore.getState().loadPapers()
    } catch (e) {
      patchReport(key, { error: '同步知识库失败: ' + String(e) })
    }
  },

  addHighlight: (key, h) => {
    const item: SciHighlight = {
      ...h,
      id: 'hl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      createdAt: Date.now(),
    }
    set((s) => {
      const next = { ...s.highlights, [key]: [...(s.highlights[key] ?? []), item] }
      saveStoredHighlights(next)
      return { highlights: next }
    })
  },

  removeHighlight: (key, id) => {
    set((s) => {
      const next = {
        ...s.highlights,
        [key]: (s.highlights[key] ?? []).filter((h) => h.id !== id),
      }
      saveStoredHighlights(next)
      return { highlights: next }
    })
  },

  // ── idea 思考 ──────────────────────────────────────────────────────────────

  ideaSessionId: null,
  ideaMd: '',
  ideaGenerating: false,
  ideaSavedPath: null,
  ideaError: null,
  ideaMessages: [],
  ideaStreaming: false,
  ideaStreamText: '',

  generateIdeas: async (paperIds, instruction) => {
    if (get().ideaGenerating || paperIds.length === 0) return
    const sel = parseModelKey(get().modelKey)
    if (!sel) {
      set({ ideaError: '尚未选择模型(请先在「设置」添加 OpenAI 兼容服务商)' })
      return
    }
    const taskId = 'sci-idea-' + Date.now()
    const registry = useTaskRegistry.getState()
    registry.registerTask({
      id: taskId,
      module: 'science',
      title: 'idea 生成 · ' + paperIds.length + ' 篇文献',
      detail: '整理资料中',
    })
    set({
      ideaGenerating: true,
      ideaError: null,
      ideaMd: '',
      ideaSavedPath: null,
      ideaMessages: [],
      ideaStreamText: '',
    })
    try {
      const parts: string[] = []
      for (const id of paperIds) {
        const p = await tauriInvoke<Paper | null>('kb_get_paper', { id })
        if (!p) continue
        const lines: string[] = []
        lines.push('### ' + (p.title || p.orig_filename || id))
        if (p.authors) lines.push('- 作者: ' + p.authors)
        if (p.year) lines.push('- 年份: ' + p.year)
        if (p.venue) lines.push('- 来源: ' + p.venue)
        if (p.doi) lines.push('- DOI: ' + p.doi)
        if (p.notes) lines.push('- 我的笔记: ' + p.notes)
        if (p.abstract) {
          lines.push('')
          lines.push('摘要: ' + p.abstract)
        }
        if (p.analyzed === 1 && p.analysis_md_path) {
          try {
            const md = await kbReadText(id, 'analysis')
            lines.push('')
            lines.push('已有分析报告摘录:')
            lines.push(md.slice(0, 4000))
          } catch {
            /* 报告文件缺失时仅用元数据 */
          }
        }
        parts.push(lines.join(NL))
      }
      if (parts.length === 0) throw new Error('所选知识库条目读取失败')

      registry.updateTask(taskId, { detail: '模型生成中' })
      const prompt =
        '我从科研知识库挑选了 ' + parts.length + ' 篇文献(元数据/笔记/已有分析报告见下)。' +
        '请综合这些文献,输出 Markdown 格式的研究 idea 清单(3-6 条)。每条 idea 包含:' + NL +
        '- 标题与一句话概述' + NL +
        '- 动机与依据(引用具体是哪几篇文献、什么结论)' + NL +
        '- 可行的技术路线' + NL +
        '- 风险与最小验证实验' + NL +
        '直接输出 Markdown 正文,不要外层代码围栏。' +
        (instruction.trim() ? NL + '我的附加要求: ' + instruction.trim() : '') +
        NL + NL + '--- 文献资料 ---' + NL + NL + parts.join(NL + NL)

      const sessionId = await createChatSession('idea 思考 · ' + parts.length + ' 篇文献', sel.model)
      sessionTargets.set(sessionId, { kind: 'idea' })
      set({ ideaSessionId: sessionId })
      const md = await runChatTurn(sessionId, sel.model, sel.providerId, prompt)
      set({ ideaMd: md, ideaGenerating: false })

      // 自动存 kb_root/ideas/(失败不影响结果展示)。
      try {
        const root = (await tauriInvoke<string>('kb_root_get')).replace(/[/\\]+$/, '')
        const path = root + '/ideas/idea_' + nowStamp() + '.md'
        await tauriInvoke<void>('export_text_file', { path, content: md })
        set({ ideaSavedPath: path })
      } catch (e) {
        console.warn('[scienceStore] idea 保存失败:', e)
      }
      registry.updateTask(taskId, { status: 'done', detail: 'idea 清单已生成' })
    } catch (e) {
      set({ ideaGenerating: false, ideaError: 'idea 生成失败: ' + String(e) })
      registry.updateTask(taskId, { status: 'error', detail: String(e) })
    }
  },

  ideaAsk: async (question) => {
    const q = question.trim()
    if (!q || get().ideaStreaming || get().ideaGenerating) return
    const sessionId = get().ideaSessionId
    const sel = parseModelKey(get().modelKey)
    if (!sessionId || !sel) return
    set((s) => ({
      ideaMessages: [...s.ideaMessages, { role: 'user', content: q }],
      ideaStreaming: true,
      ideaStreamText: '',
      ideaError: null,
    }))
    try {
      const reply = await runChatTurn(sessionId, sel.model, sel.providerId, q)
      set((s) => ({
        ideaMessages: [...s.ideaMessages, { role: 'assistant', content: reply }],
        ideaStreaming: false,
        ideaStreamText: '',
      }))
    } catch (e) {
      set({ ideaStreaming: false, ideaStreamText: '', ideaError: '追问失败: ' + String(e) })
    }
  },

  resetIdea: () => {
    set({
      ideaSessionId: null,
      ideaMd: '',
      ideaGenerating: false,
      ideaSavedPath: null,
      ideaError: null,
      ideaMessages: [],
      ideaStreaming: false,
      ideaStreamText: '',
    })
  },
}))

// ── delta 分发(函数声明提升,监听器安装于首次模型调用时) ────────────────────

function dispatchDelta(sessionId: string, buf: string) {
  const target = sessionTargets.get(sessionId)
  if (!target) return
  if (target.kind === 'paper') {
    const key = target.key
    useScienceStore.setState((s) => ({
      chats: { ...s.chats, [key]: { ...(s.chats[key] ?? emptyChat()), streamText: buf } },
    }))
  } else if (target.kind === 'report') {
    const key = target.key
    useScienceStore.setState((s) => {
      const r = s.reports[key]
      if (!r || !r.generating) return {}
      return { reports: { ...s.reports, [key]: { ...r, md: buf } } }
    })
  } else {
    useScienceStore.setState((s) =>
      s.ideaGenerating ? { ideaMd: buf } : { ideaStreamText: buf },
    )
  }
}
