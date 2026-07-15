// Office store — 「办公」板块 Excel / Word / PDF 三个子窗口的状态与模型通道
// （PPT 窗口的状态机在 artifactStore）。
//
// 复用后端 chat_send（会话 + 流式，事件名 studio-event）作为唯一模型调用
// 通道。为不与「对话」页耦合，每次任务惰性创建一个隐藏会话，并注册独立的
// studio-event 监听。监听与全部关键状态都在 store 层：组件卸载/切换页面
// 不会中断任务，重挂后完整恢复（快照另存 localStorage，重启也能恢复稳定态）。
//
// 多通道并发：excel / word / pdf 各自最多一个进行中的请求（pending 按
// session_id 索引），互不阻塞；长任务同时登记到 taskRegistryStore，
// 由底部全局任务条展示。
//
// 附件：直接走后端 chat_send 的 attachments 参数
//   （src-tauri/src/studio.rs::build_user_content）——
//   kind:"text" 附件由后端内联为 "\n\n[附件 name]\n内容"；
//   kind:"image" 附件（data URL）作为 {type:"image_url"} 内容块走多模态。

import { create } from 'zustand'
import type { AggModel, Attachment } from './studioStore'
import { useTaskRegistry } from './taskRegistryStore'
import { filesToAttachments } from '../lib/attachments'

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
  // usage fields (available when backend includes them in done event)
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost?: number
}

// ── 表格数据模型（Excel 窗口的单一数据源） ──────────────────────────

export type CellValue = string | number | boolean | null

export interface TableData {
  headers: string[]
  rows: CellValue[][]
}

/** 发送给模型的数据规模上限（行数 / 序列化字符数）。 */
export const MAX_MODEL_ROWS = 500
export const MAX_MODEL_CHARS = 120_000
/** 上传文件大小上限（xlsx / csv）。 */
export const MAX_XLSX_BYTES = 5 * 1024 * 1024
/** PDF 上传上限。 */
export const MAX_PDF_BYTES = 50 * 1024 * 1024

// ── JSON 提取（容忍 ```json 围栏与前后杂文；与 artifactStore 同策略） ──

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

function normalizeCellValue(v: unknown): CellValue {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return v
  return String(v)
}

/** 解析模型返回的表格 JSON：{headers, rows, summary?}。结构不合法返回 null。 */
export function parseTableResult(
  text: string,
): { table: TableData; summary: string } | null {
  const root = extractJsonObject(text)
  if (!isRecord(root)) return null
  if (!Array.isArray(root.headers) || !Array.isArray(root.rows)) return null
  const headers = root.headers.map((h) => String(h ?? ''))
  if (headers.length === 0) return null
  const rows: CellValue[][] = []
  for (const r of root.rows) {
    if (!Array.isArray(r)) continue
    rows.push(r.map(normalizeCellValue))
  }
  return {
    table: { headers, rows },
    summary: typeof root.summary === 'string' ? root.summary : '',
  }
}

/** 从模型回复中提取 Markdown 正文（剥掉可能包裹的 ```markdown 围栏）。 */
export function extractMarkdown(text: string): string {
  const t = (text ?? '').trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)```\s*$/i.exec(t)
  if (fenced) return fenced[1].trim()
  return t
}

// ── CSV 解析（极简 RFC4180：引号 / 转义引号 / 换行） ─────────────────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 丢弃完全空白的行
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** 把表格序列化成给模型看的 JSON（按行数 / 字符数截断，返回截断说明）。 */
function serializeTableForModel(table: TableData): {
  json: string
  truncatedNote: string
} {
  let rows = table.rows
  let note = ''
  if (rows.length > MAX_MODEL_ROWS) {
    rows = rows.slice(0, MAX_MODEL_ROWS)
    note = `（注意：原表共 ${table.rows.length} 行，因规模限制只发送了前 ${MAX_MODEL_ROWS} 行）`
  }
  let json = JSON.stringify({ headers: table.headers, rows })
  while (json.length > MAX_MODEL_CHARS && rows.length > 10) {
    rows = rows.slice(0, Math.floor(rows.length / 2))
    note = `（注意：原表共 ${table.rows.length} 行，因数据量过大只发送了前 ${rows.length} 行）`
    json = JSON.stringify({ headers: table.headers, rows })
  }
  return { json, truncatedNote: note }
}

// ── Blob 下载（浏览器通用） ──────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// ── 模型 prompt ──────────────────────────────────────────────────────

const EXCEL_PROMPT_HEAD = `你是「表格数据处理助手」。下面给出一张表格的数据（JSON：headers 为列名数组，rows 为数据行数组）和用户的处理指令。请严格按指令处理数据，然后**只输出一个 JSON 对象**（可包在 \`\`\`json 代码块里），JSON 之外不要任何文字。输出格式：
{"headers":["列1","列2"],"rows":[["a",1],["b",2]],"summary":"一句话说明做了什么修改"}
要求：
1. headers/rows 必须是处理后的**完整结果表**（不是差异、不是片段）。
2. 单元格值只能是 字符串/数字/布尔/null；日期用 "YYYY-MM-DD" 字符串。
3. 涉及计算（求和/平均等）时用数字结果，不要输出公式文本。
4. summary 用中文简要说明修改内容与影响的行列。
5. 若指令无法执行（如列不存在），headers/rows 原样返回，并在 summary 中说明原因。
6. 若消息附有截图/图片：以图片为目标样式或数据来源——把表格处理成截图所示的样子，或按截图内容补全/生成数据。
7. 若当前表格为空（headers 为空数组）：这是「从零新建」场景，请直接根据指令（和图片，如有）设计列并生成完整表格。`

const WORD_PROMPT_HEAD = `你是「Word 文档撰写助手」。请根据用户需求撰写文档内容，**只输出 Markdown 正文**，不要任何解释、前言或收尾寒暄。
要求：
1. 用规范 Markdown：# 一级标题、## 二级标题、- 无序列表、1. 有序列表、**加粗**；不要使用 HTML 标签。
2. 结构完整、层级清晰、用词正式；除非用户另有要求，使用中文。
3. 若用户给了参考材料 / 附件，以其为事实依据，不要虚构关键信息；若附有图片，请把图片中的内容一并作为参考。`

function pdfTranslatePrompt(targetLang: string): string {
  return `你是「学术文档翻译助手」。下面是从 PDF 提取的一段原文文本（可能带有断行、页眉页脚、页码等噪音）。请把它完整翻译成${targetLang}，**只输出译文 Markdown 正文**，不要任何解释或前后缀。
要求：
1. 保留文章结构：标题用 #/##，列表用 -/1.，强调用 **加粗**；合并被硬换行打断的句子；忽略页眉、页脚与孤立页码。
2. **数学公式必须保真**：一律输出 LaTeX——行内公式用 $...$，独立成行的公式用 $$...$$；变量、上下标、希腊字母原样保留，绝不要把公式意译成文字。
3. 术语翻译准确一致；人名、机构名、文献引用标号保留原文。
4. 不要遗漏内容，不要总结压缩；表格可用 Markdown 表格或逐行文本表达。`
}

const PDF_OUTLINE_PROMPT = `你是「演讲要点提炼助手」。下面给出一份或多份 PDF 文档的提取文本。请通读后提炼出适合做**演讲 PPT** 的完整要点大纲，只输出 Markdown，不要解释：
1. 先给出建议的演讲标题（# 一级标题）。
2. 然后按逐页幻灯片组织：## 每页标题，页内用 - 列出 2~5 条要点（短句）。
3. 覆盖：背景动机 → 核心内容/方法 → 关键结果/数据 → 结论与展望；多份文档时做恰当的综合与对比。
4. 保留关键数字与结论；公式用 LaTeX（$...$）。控制在 8~15 页。`

// ── 阶段状态 ────────────────────────────────────────────────────────

export type OfficeModuleKey = 'ppt' | 'excel' | 'word' | 'pdf'

export type ExcelStage =
  | 'idle' // 未上传
  | 'parsing' // 解析文件中
  | 'ready' // 已解析，等待指令
  | 'processing' // 模型处理中（流式）
  | 'done' // 有新版本可下载

export type WordStage =
  | 'idle' // 输入需求
  | 'generating' // 模型生成中（流式）
  | 'done' // 有 Markdown 结果可下载

export type PdfStage =
  | 'idle' // 未上传
  | 'parsing' // pdfjs 提取中
  | 'ready' // 已提取，等待操作
  | 'translating' // 逐批翻译中
  | 'summarizing' // 提炼演讲要点中（转 PPT 前置步骤）
  | 'done' // 翻译完成，可下载 .docx

export interface ExcelDiff {
  summary: string
  rowsBefore: number
  rowsAfter: number
  colsBefore: number
  colsAfter: number
}

export interface PdfDoc {
  name: string
  /** 每页提取的纯文本。 */
  pages: string[]
}

export interface PdfProgress {
  done: number
  total: number
}

// ── Office conversation history ─────────────────────────────────────

export interface OfficeHistoryStep {
  role: 'user' | 'assistant'
  text: string
}

export interface OfficeHistoryEntry {
  id: string
  module: OfficeModuleKey
  title: string
  ts: number
  steps: OfficeHistoryStep[]
  status: 'running' | 'done' | 'error'
}

const OFFICE_HISTORY_KEY = 'iris.office.history.v1'
const OFFICE_HISTORY_CAP = 100

function loadOfficeHistory(): OfficeHistoryEntry[] {
  try {
    const raw = localStorage.getItem(OFFICE_HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as OfficeHistoryEntry[]
    return Array.isArray(arr) ? arr.slice(0, OFFICE_HISTORY_CAP) : []
  } catch {
    return []
  }
}

function saveOfficeHistory(entries: OfficeHistoryEntry[]): void {
  try {
    localStorage.setItem(OFFICE_HISTORY_KEY, JSON.stringify(entries.slice(0, OFFICE_HISTORY_CAP)))
  } catch { /* quota exceeded or unavailable */ }
}

type Channel = 'excel' | 'word' | 'pdf'

interface OfficeStore {
  /** 办公页当前打开的子窗口（提升到 store：离开页面回来不丢）。 */
  activeModule: OfficeModuleKey | null
  setActiveModule: (m: OfficeModuleKey | null) => void

  // 模型选择（Excel/Word/PDF 共用；PPT 窗口用 artifactStore 自己的）
  aggModels: AggModel[]
  modelsLoaded: boolean
  currentModel: string
  currentProviderId: string | null
  loadModels: () => Promise<void>
  setModelSel: (providerId: string, modelId: string) => void

  /** 各通道流式增量文本（供 UI 展示）。 */
  excelStreamText: string
  wordStreamText: string
  pdfStreamText: string
  /** 停止某通道当前请求（chat_stop）。 */
  stopChannel: (c: Channel) => Promise<void>

  // ── Excel ──
  excelStage: ExcelStage
  excelFileName: string
  excelTable: TableData | null
  excelDiff: ExcelDiff | null
  excelError: string | null
  excelInstruction: string
  excelAttachments: Attachment[]
  excelWarnings: string[]
  setExcelInstruction: (v: string) => void
  excelAddFiles: (files: File[]) => Promise<void>
  excelRemoveAttachment: (i: number) => void
  excelLoadFile: (file: File) => Promise<void>
  /** 不上传文件，从空表开始（模型可从零生成表格）。 */
  excelNewBlank: () => void
  excelRun: () => Promise<void>
  excelDownload: () => Promise<void>
  excelReset: () => void

  // ── Word ──
  wordStage: WordStage
  wordMarkdown: string
  wordError: string | null
  wordRequirement: string
  wordReference: string
  wordAttachments: Attachment[]
  wordWarnings: string[]
  setWordRequirement: (v: string) => void
  setWordReference: (v: string) => void
  wordAddFiles: (files: File[]) => Promise<void>
  wordRemoveAttachment: (i: number) => void
  wordGenerate: () => Promise<void>
  wordDownload: () => Promise<void>
  wordReset: () => void

  // ── PDF 智能翻译 ──
  pdfStage: PdfStage
  pdfDocs: PdfDoc[]
  /** 转 Word 模式作用的文档下标（转 PPT 用全部文档）。 */
  pdfSelected: number
  pdfTargetLang: string
  pdfProgress: PdfProgress | null
  /** 翻译结果（Markdown，含 LaTeX 公式）。 */
  pdfMarkdown: string
  pdfResultName: string
  pdfError: string | null
  pdfLogs: string[]
  pdfAddFiles: (files: File[]) => Promise<void>
  pdfRemoveDoc: (i: number) => void
  pdfSetSelected: (i: number) => void
  pdfSetTargetLang: (lang: string) => void
  /** 逐批翻译选中的 PDF → Markdown（公式 LaTeX），可中断。 */
  pdfTranslate: () => Promise<void>
  /** 请求中断翻译（当前批完成/停止后生效）。 */
  pdfCancel: () => Promise<void>
  /** 翻译结果 → .docx（LaTeX→MathML→OMML 公式保真）下载。 */
  pdfDownloadDocx: () => Promise<void>
  /** 全部 PDF 提炼演讲要点 → 交给 artifactStore 生成 HTML 演示稿。 */
  pdfToPpt: () => Promise<void>
  pdfReset: () => void

  // ── 对话式历史 ──
  officeHistory: OfficeHistoryEntry[]
  _historyPush: (module: OfficeModuleKey, title: string, step: OfficeHistoryStep) => void
  _historyFinalize: (module: OfficeModuleKey, status: 'done' | 'error') => void
  restoreHistory: (id: string) => void
  deleteOfficeHistory: (id: string) => void
}

// ── 隐藏会话 + 独立 studio-event 监听（多通道并发，一问一答 promise 化） ──

interface RunResult {
  text: string
  stopped: boolean
}

interface PendingRun {
  sessionId: string
  buf: string
  onDelta?: (buf: string) => void
  resolve: (r: RunResult) => void
  reject: (err: Error) => void
}

/** 进行中的请求，按隐藏会话 id 索引（各通道互不阻塞）。 */
const pendingBySession = new Map<string, PendingRun>()
/** 通道 → 最近一次请求的会话 id（stopChannel 用）。 */
const sessionByChannel = new Map<Channel, string>()
let listenerReady = false

async function ensureListener(): Promise<void> {
  if (listenerReady || !isTauri) return
  listenerReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      if (!p.session_id) return
      const run = pendingBySession.get(p.session_id)
      if (!run) return
      switch (p.type) {
        case 'delta':
          run.buf += p.text ?? ''
          run.onDelta?.(run.buf)
          break
        case 'done':
          pendingBySession.delete(p.session_id)
          // 用量落库：done 事件若带 usage 字段，写入 pi_usage 表统一统计。
          if (p.input_tokens || p.output_tokens) {
            const model = useOfficeStore.getState().currentModel
            void tauriInvoke<void>('pi_usage_insert_manual', {
              sessionId: p.session_id,
              model: 'office:' + model,
              provider: 'studio',
              input: p.input_tokens ?? 0,
              output: p.output_tokens ?? 0,
              cacheRead: p.cache_read_tokens ?? 0,
              cacheWrite: p.cache_write_tokens ?? 0,
              cost: p.cost ?? 0,
            }).catch(() => {})
          }
          run.resolve({
            text: p.text || run.buf,
            stopped: (p.status ?? '') === 'stopped',
          })
          break
        case 'error':
          pendingBySession.delete(p.session_id)
          run.reject(new Error(p.message ?? '生成出错'))
          break
        default:
          break
      }
    })
  } catch (err) {
    listenerReady = false
    console.warn('[officeStore] failed to register studio-event listener:', err)
  }
}

// ── 全局任务注册（底部任务条） ───────────────────────────────────────

function regTask(id: string, title: string, detail?: string): void {
  useTaskRegistry.getState().registerTask({ id, module: 'office', title, detail })
}

function setTask(
  id: string,
  status: 'running' | 'done' | 'error',
  detail?: string,
): void {
  useTaskRegistry.getState().updateTask(id, { status, detail })
}

// ── 快照持久化（localStorage；重启后恢复稳定态） ─────────────────────

const OFFICE_SNAPSHOT_KEY = 'agentboard.office.v1'
const SNAPSHOT_MAX_CHARS = 4_000_000

interface OfficeSnapshot {
  v: 1
  savedAt: number
  activeModule: OfficeModuleKey | null
  excelStage: ExcelStage
  excelFileName: string
  excelTable: TableData | null
  excelDiff: ExcelDiff | null
  excelInstruction: string
  excelAttachments: Attachment[]
  wordStage: WordStage
  wordMarkdown: string
  wordRequirement: string
  wordReference: string
  wordAttachments: Attachment[]
  pdfStage: PdfStage
  pdfDocs: PdfDoc[]
  pdfSelected: number
  pdfTargetLang: string
  pdfMarkdown: string
  pdfResultName: string
  pdfLogs: string[]
}

function loadOfficeSnapshot(): OfficeSnapshot | null {
  try {
    const raw = localStorage.getItem(OFFICE_SNAPSHOT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as OfficeSnapshot
    if (d.v !== 1) return null
    return d
  } catch {
    return null
  }
}

/** 流式中间态 → 最近的稳定阶段（重启后无法续流）。 */
function stableExcelStage(stage: ExcelStage, table: TableData | null): ExcelStage {
  if (stage === 'parsing' || stage === 'processing') return table ? 'ready' : 'idle'
  return table ? stage : 'idle'
}
function stableWordStage(stage: WordStage, md: string): WordStage {
  if (stage === 'generating') return md ? 'done' : 'idle'
  return md ? stage : 'idle'
}
function stablePdfStage(stage: PdfStage, docs: PdfDoc[], md: string): PdfStage {
  if (docs.length === 0) return 'idle'
  if (stage === 'parsing' || stage === 'translating' || stage === 'summarizing')
    return 'ready'
  if (stage === 'done' && !md) return 'ready'
  return stage
}

const snap = loadOfficeSnapshot()

let officeSaveTimer: ReturnType<typeof setTimeout> | null = null

/** 把快照写盘；超限时按「附件图片 → PDF 页文本 → Excel 行」逐级裁剪。 */
function persistOfficeSnapshot(): void {
  const s = useOfficeStore.getState()
  const full: OfficeSnapshot = {
    v: 1,
    savedAt: Date.now(),
    activeModule: s.activeModule,
    excelStage: s.excelStage,
    excelFileName: s.excelFileName,
    excelTable: s.excelTable,
    excelDiff: s.excelDiff,
    excelInstruction: s.excelInstruction,
    excelAttachments: s.excelAttachments,
    wordStage: s.wordStage,
    wordMarkdown: s.wordMarkdown,
    wordRequirement: s.wordRequirement,
    wordReference: s.wordReference,
    wordAttachments: s.wordAttachments,
    pdfStage: s.pdfStage,
    pdfDocs: s.pdfDocs,
    pdfSelected: s.pdfSelected,
    pdfTargetLang: s.pdfTargetLang,
    pdfMarkdown: s.pdfMarkdown,
    pdfResultName: s.pdfResultName,
    pdfLogs: s.pdfLogs,
  }
  const stripImages = (atts: Attachment[]) =>
    atts.filter((a) => a.kind !== 'image')
  const tiers: (() => OfficeSnapshot)[] = [
    () => full,
    () => ({
      ...full,
      excelAttachments: stripImages(full.excelAttachments),
      wordAttachments: stripImages(full.wordAttachments),
    }),
    () => ({
      ...full,
      excelAttachments: stripImages(full.excelAttachments),
      wordAttachments: stripImages(full.wordAttachments),
      pdfDocs: full.pdfDocs.map((d) => ({ name: d.name, pages: [] })),
    }),
    () => ({
      ...full,
      excelAttachments: [],
      wordAttachments: [],
      pdfDocs: [],
      excelTable: full.excelTable
        ? { headers: full.excelTable.headers, rows: full.excelTable.rows.slice(0, 200) }
        : null,
    }),
  ]
  for (const build of tiers) {
    try {
      const json = JSON.stringify(build())
      if (json.length > SNAPSHOT_MAX_CHARS) continue
      localStorage.setItem(OFFICE_SNAPSHOT_KEY, json)
      return
    } catch {
      /* 尝试下一档 */
    }
  }
}

function scheduleOfficeSave(): void {
  if (officeSaveTimer != null) clearTimeout(officeSaveTimer)
  officeSaveTimer = setTimeout(() => {
    officeSaveTimer = null
    persistOfficeSnapshot()
  }, 800)
}

// ── PDF 文本提取（pdfjs，动态 import 保持分包） ──────────────────────

async function extractPdfPages(file: File): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
    .default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() })
  const doc = await task.promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      let text = ''
      for (const item of tc.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str === 'string') text += item.str
        if (item.hasEOL) text += '\n'
      }
      pages.push(text.trim())
      page.cleanup()
    }
    return pages
  } finally {
    void task.destroy()
  }
}

/** 把若干页拼成不超过 maxChars 的批次（单页超限则独占一批）。 */
function batchPages(pages: string[], maxChars: number): string[] {
  const batches: string[] = []
  let cur = ''
  for (const p of pages) {
    if (!p.trim()) continue
    if (cur && cur.length + p.length + 2 > maxChars) {
      batches.push(cur)
      cur = p
    } else {
      cur = cur ? `${cur}\n\n${p}` : p
    }
  }
  if (cur) batches.push(cur)
  return batches
}

/** PDF 取消标志（模块级：与任务同生命周期，跨组件生效）。 */
let pdfCancelRequested = false
/** 转 PPT 流程进行中的互斥标志。 */
let pdfPptBusy = false

// ── store ────────────────────────────────────────────────────────────

export const useOfficeStore = create<OfficeStore>((set, get) => {
  /** 发起一轮模型调用：新建隐藏会话 → chat_send → 等 done/error。 */
  async function runChat(
    channel: Channel,
    userContent: string,
    title: string,
    attachments: Attachment[] = [],
  ): Promise<RunResult> {
    if (!isTauri) throw new Error('模型调用仅在桌面应用内可用')
    const prevSid = sessionByChannel.get(channel)
    if (prevSid && pendingBySession.has(prevSid))
      throw new Error('该窗口已有任务在处理中，请先等待或停止')
    const model = get().currentModel
    if (!model) throw new Error('尚未选择模型')
    await ensureListener()

    // 每轮任务用全新隐藏会话：上下文自包含，避免历史消息拖大 token。
    const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
      title,
      model,
    })
    const sessionId = row.id
    sessionByChannel.set(channel, sessionId)

    const streamField =
      channel === 'excel'
        ? 'excelStreamText'
        : channel === 'word'
          ? 'wordStreamText'
          : 'pdfStreamText'
    set({ [streamField]: '' } as Partial<OfficeStore>)

    const promise = new Promise<RunResult>((resolve, reject) => {
      pendingBySession.set(sessionId, {
        sessionId,
        buf: '',
        onDelta: (buf) => set({ [streamField]: buf } as Partial<OfficeStore>),
        resolve,
        reject,
      })
    })
    try {
      await tauriInvoke<string>('chat_send', {
        sessionId,
        userContent,
        attachments,
        model,
        providerId: get().currentProviderId ?? null,
      })
    } catch (e) {
      pendingBySession.delete(sessionId)
      throw e instanceof Error ? e : new Error(String(e))
    }
    return promise
  }

  /** 通用的「文件 → 附件」入库（图片压缩为 data URL；文本内联；docx 抽文本）。 */
  async function ingestFiles(
    files: File[],
    existing: Attachment[],
  ): Promise<{ attachments: Attachment[]; warnings: string[] }> {
    const docxFiles = files.filter((f) => /\.docx$/i.test(f.name))
    const rest = files.filter((f) => !/\.docx$/i.test(f.name))
    const out: Attachment[] = []
    const warnings: string[] = []
    for (const f of docxFiles) {
      try {
        const { extractDocxText } = await import(
          '../components/office/docxText'
        )
        const text = await extractDocxText(f)
        if (!text.trim()) {
          warnings.push(`「${f.name}」没有可提取的正文，已跳过`)
          continue
        }
        const MAX = 200 * 1024
        out.push({
          kind: 'text',
          name: f.name,
          text:
            text.length > MAX
              ? text.slice(0, MAX) + '\n\n……（文档过长，已截取前 200KB）'
              : text,
        })
      } catch (e) {
        warnings.push(
          `「${f.name}」解析失败：${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    if (rest.length > 0) {
      const existingText = existing
        .filter((a) => a.kind === 'text')
        .reduce((n, a) => n + (a.text?.length ?? 0), 0)
      const res = await filesToAttachments(rest, existingText)
      out.push(...res.attachments)
      warnings.push(...res.warnings)
    }
    return { attachments: out, warnings }
  }

  return {
    activeModule: snap?.activeModule ?? null,
    setActiveModule: (m) => set({ activeModule: m }),

    aggModels: [],
    modelsLoaded: false,
    currentModel: '',
    currentProviderId: null,

    loadModels: async () => {
      if (!isTauri) {
        set({ modelsLoaded: true })
        return
      }
      try {
        const raw = await tauriInvoke<RawAggModel[]>('providers_models')
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
            !!s.currentModel &&
            aggModels.some((m) => m.modelId === s.currentModel)
          // 默认 gpt-5.5，没有则退到第一个可用 chat 模型。
          const preferred =
            aggModels.find((m) => m.modelId === 'gpt-5.5') ?? aggModels[0]
          return {
            aggModels,
            modelsLoaded: true,
            currentModel: keep ? s.currentModel : preferred?.modelId ?? '',
            currentProviderId: keep
              ? s.currentProviderId
              : preferred?.providerId ?? null,
          }
        })
      } catch (e) {
        set({ modelsLoaded: true })
        console.warn('[officeStore] loadModels failed:', e)
      }
    },

    setModelSel: (providerId, modelId) =>
      set({ currentProviderId: providerId, currentModel: modelId }),

    excelStreamText: '',
    wordStreamText: '',
    pdfStreamText: '',

    stopChannel: async (c) => {
      const sid = sessionByChannel.get(c)
      if (!sid || !pendingBySession.has(sid)) return
      try {
        await tauriInvoke<void>('chat_stop', { sessionId: sid })
      } catch (e) {
        console.warn('[officeStore] stop failed:', e)
      }
    },

    // ── Excel ──────────────────────────────────────────────────────

    excelStage: snap ? stableExcelStage(snap.excelStage, snap.excelTable) : 'idle',
    excelFileName: snap?.excelFileName ?? '',
    excelTable: snap?.excelTable ?? null,
    excelDiff: snap?.excelDiff ?? null,
    excelError: null,
    excelInstruction: snap?.excelInstruction ?? '',
    excelAttachments: snap?.excelAttachments ?? [],
    excelWarnings: [],

    setExcelInstruction: (v) => set({ excelInstruction: v }),

    excelAddFiles: async (files) => {
      if (files.length === 0) return
      const { attachments, warnings } = await ingestFiles(
        files,
        get().excelAttachments,
      )
      set((s) => ({
        excelAttachments: [...s.excelAttachments, ...attachments],
        excelWarnings: warnings,
      }))
    },

    excelRemoveAttachment: (i) =>
      set((s) => ({
        excelAttachments: s.excelAttachments.filter((_, idx) => idx !== i),
      })),

    excelLoadFile: async (file) => {
      if (file.size > MAX_XLSX_BYTES) {
        set({
          excelError: `文件超过 ${Math.round(MAX_XLSX_BYTES / 1024 / 1024)}MB 上限（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB），请先拆分或精简后再上传`,
        })
        return
      }
      const name = file.name || '表格'
      const isCsv = /\.csv$/i.test(name)
      const isXlsx = /\.xlsx$/i.test(name)
      if (!isCsv && !isXlsx) {
        set({ excelError: '仅支持 .xlsx 与 .csv 文件' })
        return
      }
      set({
        excelStage: 'parsing',
        excelFileName: name,
        excelError: null,
        excelDiff: null,
      })
      try {
        let table: TableData
        if (isCsv) {
          const text = await file.text()
          const grid = parseCsv(text)
          if (grid.length === 0) throw new Error('文件为空或没有可识别的数据行')
          table = { headers: grid[0].map(String), rows: grid.slice(1) }
        } else {
          const ExcelJS = (await import('exceljs')).default
          const wb = new ExcelJS.Workbook()
          await wb.xlsx.load(await file.arrayBuffer())
          const ws = wb.worksheets[0]
          if (!ws) throw new Error('工作簿里没有工作表')
          const grid: CellValue[][] = []
          ws.eachRow({ includeEmpty: false }, (row) => {
            const vals: CellValue[] = []
            // row.values 下标从 1 开始（0 位为空洞）
            const raw = row.values as unknown[]
            for (let c = 1; c < raw.length; c++) {
              vals.push(normalizeExcelCell(raw[c]))
            }
            grid.push(vals)
          })
          if (grid.length === 0) throw new Error('工作表为空')
          const width = Math.max(...grid.map((r) => r.length))
          const pad = (r: CellValue[]) =>
            r.length < width
              ? [...r, ...Array<CellValue>(width - r.length).fill(null)]
              : r
          table = {
            headers: pad(grid[0]).map((v) => (v == null ? '' : String(v))),
            rows: grid.slice(1).map(pad),
          }
        }
        set({ excelStage: 'ready', excelTable: table, excelError: null })
      } catch (e) {
        set({
          excelStage: 'idle',
          excelTable: null,
          excelError: `解析失败：${e instanceof Error ? e.message : String(e)}`,
        })
      }
    },

    excelNewBlank: () =>
      set({
        excelStage: 'ready',
        excelFileName: '新建表格.xlsx',
        excelTable: { headers: [], rows: [] },
        excelDiff: null,
        excelError: null,
      }),

    excelRun: async () => {
      const instr = get().excelInstruction.trim()
      const { excelTable, excelStage, excelAttachments } = get()
      if (!instr || !excelTable) return
      if (excelStage !== 'ready' && excelStage !== 'done') return
      const prevStage = excelStage
      const before = excelTable
      const isBlank = before.headers.length === 0 && before.rows.length === 0
      const { json, truncatedNote } = serializeTableForModel(before)
      const tableBlock = isBlank
        ? '（当前为空表——请按指令从零生成完整表格）'
        : `表格数据（JSON）${truncatedNote}：\n${json}`
      const userContent =
        `${EXCEL_PROMPT_HEAD}\n\n———\n${tableBlock}\n\n` +
        `———\n用户指令：${instr}`
      const taskId = `office-excel-${Date.now()}`
      regTask(taskId, 'Excel · 表格处理', instr.slice(0, 40))
      set({ excelStage: 'processing', excelError: null, excelDiff: null })
      try {
        const { text, stopped } = await runChat(
          'excel',
          userContent,
          'Office · Excel 处理',
          excelAttachments,
        )
        if (stopped) {
          set({ excelStage: prevStage })
          setTask(taskId, 'error', '已停止')
          return
        }
        const parsed = parseTableResult(text)
        if (!parsed) {
          set({
            excelStage: prevStage,
            excelError: '模型没有返回有效的表格 JSON，请重试或换个说法/模型',
          })
          setTask(taskId, 'error', '返回格式无效')
          return
        }
        set({
          excelStage: 'done',
          excelTable: parsed.table,
          excelInstruction: '',
          excelAttachments: [],
          excelWarnings: [],
          excelDiff: {
            summary: parsed.summary || '（模型未提供修改说明）',
            rowsBefore: before.rows.length,
            rowsAfter: parsed.table.rows.length,
            colsBefore: before.headers.length,
            colsAfter: parsed.table.headers.length,
          },
        })
        setTask(taskId, 'done', parsed.summary.slice(0, 60))
      } catch (e) {
        set({
          excelStage: prevStage,
          excelError: `处理失败：${e instanceof Error ? e.message : String(e)}`,
        })
        setTask(taskId, 'error', e instanceof Error ? e.message : String(e))
      }
    },

    excelDownload: async () => {
      const { excelTable, excelFileName } = get()
      if (!excelTable) return
      try {
        const ExcelJS = (await import('exceljs')).default
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('Sheet1')
        ws.addRow(excelTable.headers)
        excelTable.rows.forEach((r) => ws.addRow(r))
        ws.getRow(1).font = { bold: true }
        const buf = await wb.xlsx.writeBuffer()
        const base = excelFileName.replace(/\.(xlsx|csv)$/i, '') || '表格'
        downloadBlob(
          new Blob([buf], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
          `${base}-新版本.xlsx`,
        )
      } catch (e) {
        set({
          excelError: `导出失败：${e instanceof Error ? e.message : String(e)}`,
        })
      }
    },

    excelReset: () =>
      set({
        excelStage: 'idle',
        excelFileName: '',
        excelTable: null,
        excelDiff: null,
        excelError: null,
        excelInstruction: '',
        excelAttachments: [],
        excelWarnings: [],
      }),

    // ── Word ───────────────────────────────────────────────────────

    wordStage: snap ? stableWordStage(snap.wordStage, snap.wordMarkdown) : 'idle',
    wordMarkdown: snap?.wordMarkdown ?? '',
    wordError: null,
    wordRequirement: snap?.wordRequirement ?? '',
    wordReference: snap?.wordReference ?? '',
    wordAttachments: snap?.wordAttachments ?? [],
    wordWarnings: [],

    setWordRequirement: (v) => set({ wordRequirement: v }),
    setWordReference: (v) => set({ wordReference: v }),

    wordAddFiles: async (files) => {
      if (files.length === 0) return
      const { attachments, warnings } = await ingestFiles(
        files,
        get().wordAttachments,
      )
      set((s) => ({
        wordAttachments: [...s.wordAttachments, ...attachments],
        wordWarnings: warnings,
      }))
    },

    wordRemoveAttachment: (i) =>
      set((s) => ({
        wordAttachments: s.wordAttachments.filter((_, idx) => idx !== i),
      })),

    wordGenerate: async () => {
      const req = get().wordRequirement.trim()
      if (!req || get().wordStage === 'generating') return
      const prev = get().wordMarkdown
      const reference = get().wordReference
      const attachments = get().wordAttachments
      const refBlock = reference.trim()
        ? `\n\n———\n参考材料：\n${reference.trim()}`
        : ''
      // done 之后再提需求 = 在现有文稿基础上改写。
      const prevBlock =
        get().wordStage === 'done' && prev
          ? `\n\n———\n当前文稿（Markdown，请在此基础上按需求修改后输出完整新版）：\n${prev}`
          : ''
      const userContent = `${WORD_PROMPT_HEAD}\n\n———\n用户需求：${req}${refBlock}${prevBlock}`
      const taskId = `office-word-${Date.now()}`
      regTask(taskId, 'Word · 文档撰写', req.slice(0, 40))
      set({ wordStage: 'generating', wordError: null })
      try {
        const { text, stopped } = await runChat(
          'word',
          userContent,
          'Office · Word 文档',
          attachments,
        )
        if (stopped) {
          set({ wordStage: prev ? 'done' : 'idle' })
          setTask(taskId, 'error', '已停止')
          return
        }
        const md = extractMarkdown(text)
        if (!md) {
          set({
            wordStage: prev ? 'done' : 'idle',
            wordError: '模型没有返回内容，请重试',
          })
          setTask(taskId, 'error', '模型没有返回内容')
          return
        }
        set({
          wordStage: 'done',
          wordMarkdown: md,
          wordRequirement: '',
          wordAttachments: [],
          wordWarnings: [],
        })
        setTask(taskId, 'done')
      } catch (e) {
        set({
          wordStage: prev ? 'done' : 'idle',
          wordError: `生成失败：${e instanceof Error ? e.message : String(e)}`,
        })
        setTask(taskId, 'error', e instanceof Error ? e.message : String(e))
      }
    },

    wordDownload: async () => {
      const md = get().wordMarkdown
      if (!md) return
      try {
        const { markdownToDocxBlob } = await import(
          '../components/office/mdToDocx'
        )
        const blob = await markdownToDocxBlob(md)
        downloadBlob(blob, `文档-${new Date().toISOString().slice(0, 10)}.docx`)
      } catch (e) {
        set({
          wordError: `导出失败：${e instanceof Error ? e.message : String(e)}`,
        })
      }
    },

    wordReset: () =>
      set({
        wordStage: 'idle',
        wordMarkdown: '',
        wordError: null,
        wordRequirement: '',
        wordReference: '',
        wordAttachments: [],
        wordWarnings: [],
      }),

    // ── PDF 智能翻译 ────────────────────────────────────────────────

    pdfStage: snap
      ? stablePdfStage(snap.pdfStage, snap.pdfDocs, snap.pdfMarkdown)
      : 'idle',
    pdfDocs: snap?.pdfDocs ?? [],
    pdfSelected: snap?.pdfSelected ?? 0,
    pdfTargetLang: snap?.pdfTargetLang ?? '中文',
    pdfProgress: null,
    pdfMarkdown: snap?.pdfMarkdown ?? '',
    pdfResultName: snap?.pdfResultName ?? '',
    pdfError: null,
    pdfLogs: snap?.pdfLogs ?? [],

    pdfAddFiles: async (files) => {
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name))
      if (pdfs.length === 0) {
        set({ pdfError: '仅支持 .pdf 文件' })
        return
      }
      set({ pdfStage: 'parsing', pdfError: null })
      const logs: string[] = []
      const added: PdfDoc[] = []
      for (const f of pdfs) {
        if (f.size > MAX_PDF_BYTES) {
          logs.push(`「${f.name}」超过 50MB 上限，已跳过`)
          continue
        }
        try {
          const pages = await extractPdfPages(f)
          const chars = pages.reduce((n, p) => n + p.length, 0)
          if (chars === 0) {
            logs.push(
              `「${f.name}」没有可提取的文本层（可能是扫描件），已跳过`,
            )
            continue
          }
          added.push({ name: f.name, pages })
          logs.push(`「${f.name}」提取完成：${pages.length} 页 / ${chars} 字符`)
        } catch (e) {
          logs.push(
            `「${f.name}」解析失败：${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      set((s) => {
        const docs = [...s.pdfDocs, ...added]
        return {
          pdfDocs: docs,
          pdfStage: docs.length > 0 ? 'ready' : 'idle',
          pdfLogs: [...s.pdfLogs, ...logs].slice(-50),
          pdfError:
            added.length === 0 && logs.length > 0 ? logs.join('；') : null,
        }
      })
    },

    pdfRemoveDoc: (i) =>
      set((s) => {
        const docs = s.pdfDocs.filter((_, idx) => idx !== i)
        return {
          pdfDocs: docs,
          pdfSelected: Math.min(s.pdfSelected, Math.max(0, docs.length - 1)),
          pdfStage: docs.length > 0 ? s.pdfStage : 'idle',
        }
      }),

    pdfSetSelected: (i) => set({ pdfSelected: i }),
    pdfSetTargetLang: (lang) => set({ pdfTargetLang: lang }),

    pdfTranslate: async () => {
      const { pdfDocs, pdfSelected, pdfStage, pdfTargetLang } = get()
      const doc = pdfDocs[pdfSelected]
      if (!doc || pdfStage === 'translating' || pdfStage === 'summarizing')
        return
      const batches = batchPages(doc.pages, 8000)
      if (batches.length === 0) {
        set({ pdfError: '该 PDF 没有可翻译的文本' })
        return
      }
      pdfCancelRequested = false
      const taskId = `office-pdf-${Date.now()}`
      regTask(taskId, `PDF 翻译 · ${doc.name}`, `0/${batches.length} 批`)
      set({
        pdfStage: 'translating',
        pdfError: null,
        pdfMarkdown: '',
        pdfResultName: doc.name.replace(/\.pdf$/i, ''),
        pdfProgress: { done: 0, total: batches.length },
      })
      const head = pdfTranslatePrompt(pdfTargetLang)
      const parts: string[] = []
      try {
        for (let i = 0; i < batches.length; i++) {
          if (pdfCancelRequested) {
            set((s) => ({
              pdfStage: 'ready',
              pdfProgress: null,
              pdfLogs: [...s.pdfLogs, `翻译已中断（完成 ${i}/${batches.length} 批）`],
            }))
            setTask(taskId, 'error', `已中断（${i}/${batches.length}）`)
            return
          }
          const userContent =
            `${head}\n\n———\n原文（第 ${i + 1}/${batches.length} 批）：\n${batches[i]}`
          const { text, stopped } = await runChat(
            'pdf',
            userContent,
            `Office · PDF 翻译 ${i + 1}/${batches.length}`,
          )
          if (stopped || pdfCancelRequested) {
            const partial = parts.join('\n\n')
            set((s) => ({
              pdfStage: 'ready',
              pdfProgress: null,
              pdfMarkdown: partial,
              pdfLogs: [
                ...s.pdfLogs,
                `翻译已中断（完成 ${i}/${batches.length} 批${partial ? '，已保留部分译文' : ''}）`,
              ],
            }))
            setTask(taskId, 'error', `已中断（${i}/${batches.length}）`)
            return
          }
          parts.push(extractMarkdown(text))
          set({
            pdfProgress: { done: i + 1, total: batches.length },
            pdfMarkdown: parts.join('\n\n'),
          })
          setTask(taskId, 'running', `${i + 1}/${batches.length} 批`)
        }
        set((s) => ({
          pdfStage: 'done',
          pdfProgress: null,
          pdfMarkdown: parts.join('\n\n'),
          pdfLogs: [...s.pdfLogs, `「${doc.name}」翻译完成（${batches.length} 批）`],
        }))
        get()._historyPush('pdf', 'PDF: ' + doc.name, { role: 'assistant', text: batches.length + ' batches translated' })
        get()._historyFinalize('pdf', 'done')
        setTask(taskId, 'done', `${batches.length} 批完成`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set((s) => ({
          pdfStage: 'ready',
          pdfProgress: null,
          pdfMarkdown: parts.join('\n\n'),
          pdfError: `翻译失败：${msg}`,
          pdfLogs: [...s.pdfLogs, `翻译失败：${msg}`],
        }))
        setTask(taskId, 'error', msg)
      }
    },

    pdfCancel: async () => {
      pdfCancelRequested = true
      await get().stopChannel('pdf')
    },

    pdfDownloadDocx: async () => {
      const { pdfMarkdown, pdfResultName, pdfTargetLang } = get()
      if (!pdfMarkdown) return
      try {
        const { markdownToDocxBlobEx } = await import(
          '../components/office/mdToDocx'
        )
        let result: { blob: Blob; mathTotal: number; mathFailed: number }
        try {
          result = await markdownToDocxBlobEx(pdfMarkdown, { math: true })
        } catch (mathErr) {
          // Math conversion chain failed entirely -- retry without math
          console.warn('[officeStore] math conversion chain failed, retrying without math:', mathErr)
          set((s) => ({
            pdfLogs: [
              ...s.pdfLogs,
              `公式转换链加载失败（${mathErr instanceof Error ? mathErr.message : String(mathErr)}），已降级为纯文本导出`,
            ],
          }))
          result = await markdownToDocxBlobEx(pdfMarkdown, { math: false })
        }
        const { blob, mathTotal, mathFailed } = result
        set((s) => ({
          pdfLogs: [
            ...s.pdfLogs,
            mathTotal > 0
              ? `导出 .docx：公式 ${mathTotal} 处，OMML 转换成功 ${mathTotal - mathFailed} 处` +
                (mathFailed > 0 ? `，${mathFailed} 处降级为 LaTeX 原文` : '')
              : '导出 .docx 完成',
          ],
        }))
        downloadBlob(
          blob,
          `${pdfResultName || 'PDF译文'}-${pdfTargetLang}译文.docx`,
        )
      } catch (e) {
        set({
          pdfError: `导出失败：${e instanceof Error ? e.message : String(e)}`,
        })
      }
    },
    pdfToPpt: async () => {
      const { pdfDocs, pdfStage } = get()
      if (pdfDocs.length === 0 || pdfStage === 'translating' || pdfPptBusy)
        return
      pdfPptBusy = true
      const taskId = `office-pdfppt-${Date.now()}`
      const names = pdfDocs.map((d) => d.name).join('、')
      regTask(taskId, 'PDF → 演讲 PPT', '提炼要点中')
      set({ pdfStage: 'summarizing', pdfError: null })
      try {
        // 每份文档限额，整体控制在 ~60K 字符内。
        const perDoc = Math.max(
          8000,
          Math.min(30000, Math.floor(60000 / pdfDocs.length)),
        )
        const material = pdfDocs
          .map((d) => {
            const full = d.pages.join('\n\n')
            const cut =
              full.length > perDoc
                ? full.slice(0, perDoc) + '\n……（后文因篇幅截断）'
                : full
            return `【文档：${d.name}】\n${cut}`
          })
          .join('\n\n════════\n\n')
        const { text, stopped } = await runChat(
          'pdf',
          `${PDF_OUTLINE_PROMPT}\n\n———\n${material}`,
          'Office · PDF 演讲要点',
        )
        if (stopped) {
          set({ pdfStage: 'ready' })
          setTask(taskId, 'error', '已停止')
          return
        }
        const outline = extractMarkdown(text)
        if (!outline) throw new Error('模型没有返回要点大纲')
        set((s) => ({
          pdfLogs: [...s.pdfLogs, `已提炼演讲要点，正在交给 PPT 引擎生成演示稿`],
        }))
        setTask(taskId, 'running', '生成演示稿中（见 PPT 窗口）')
        // 交给 artifactStore（与 PPT 窗口同引擎），并切到 PPT 窗口的双栏编辑视图。
        const { useArtifactStore } = await import('./artifactStore')
        await useArtifactStore
          .getState()
          .generateFromMaterial(`基于 PDF 的演讲（${names}）`, outline)
        set({ pdfStage: 'ready', activeModule: 'ppt' })
        setTask(taskId, 'done', '已进入 PPT 窗口')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({ pdfStage: 'ready', pdfError: `转 PPT 失败：${msg}` })
        setTask(taskId, 'error', msg)
      } finally {
        pdfPptBusy = false
      }
    },

    pdfReset: () => {
      pdfCancelRequested = true
      set({
        pdfStage: 'idle',
        pdfDocs: [],
        pdfSelected: 0,
        pdfProgress: null,
        pdfMarkdown: '',
        pdfResultName: '',
        pdfError: null,
        pdfLogs: [],
      })
    },

    // ── Office conversation history ────────────────────────────────

    officeHistory: loadOfficeHistory(),

    _historyPush: (module, title, step) => {
      set((s) => {
        const hist = [...s.officeHistory]
        let entry = hist.find((e) => e.module === module && e.status === 'running')
        if (!entry) {
          entry = {
            id: 'oh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            module,
            title,
            ts: Date.now(),
            steps: [],
            status: 'running',
          }
          hist.unshift(entry)
        }
        entry.steps = [...entry.steps, step]
        const next = hist.slice(0, OFFICE_HISTORY_CAP)
        saveOfficeHistory(next)
        return { officeHistory: next }
      })
    },

    _historyFinalize: (module, status) => {
      set((s) => {
        const hist = s.officeHistory.map((e) =>
          e.module === module && e.status === 'running' ? { ...e, status } : e,
        )
        saveOfficeHistory(hist)
        return { officeHistory: hist }
      })
    },

    restoreHistory: (id) => {
      const entry = get().officeHistory.find((e) => e.id === id)
      if (!entry) return
      set({ activeModule: entry.module })
    },

    deleteOfficeHistory: (id) => {
      set((s) => {
        const hist = s.officeHistory.filter((e) => e.id !== id)
        saveOfficeHistory(hist)
        return { officeHistory: hist }
      })
    },
  }
})

// 状态变化 → 防抖持久化（流式增量只写 *StreamText，快照不含它们，开销可控）。
useOfficeStore.subscribe(() => scheduleOfficeSave())

/** ExcelJS 单元格值归一化：富文本/公式/超链接/日期 → 字符串或数字。 */
function normalizeExcelCell(v: unknown): CellValue {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (isRecord(v)) {
    // 公式 { formula, result } → 取计算结果
    if ('result' in v) return normalizeExcelCell(v.result)
    // 富文本 { richText: [{ text }] }
    if (Array.isArray(v.richText))
      return v.richText
        .map((t) => (isRecord(t) && typeof t.text === 'string' ? t.text : ''))
        .join('')
    // 超链接 { text, hyperlink }
    if ('text' in v) return normalizeExcelCell(v.text)
    // 错误值 { error }
    if ('error' in v) return String(v.error)
  }
  return String(v)
}
