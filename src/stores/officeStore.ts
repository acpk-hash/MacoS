// Office store — 「办公」板块 Excel / Word 两个子窗口的状态与模型通道。
//
// 复用后端 chat_send（会话 + 流式，事件名 studio-event）作为唯一模型调用
// 通道（与 artifactStore / PPT 窗口同一后端命令）。为不与「对话」页耦合，
// 每次任务惰性创建一个隐藏会话，并注册独立的 studio-event 监听，只消费
// 本 store 当前活跃会话的 delta/done/error。
//
// Excel：前端 exceljs 解析 → 表格数据（截断合理规模）+ 指令 → 模型返回
//        结构化 JSON（headers/rows/summary）→ 前端应用 → exceljs 生成新
//        xlsx → Blob 即时下载。
// Word ：需求（可粘贴参考材料）→ 模型生成 Markdown → 预览 → docx 库转
//        .docx → Blob 下载。上传 .docx 改写路径见 WordWindow 的 TODO。

import { create } from 'zustand'
import type { AggModel } from './studioStore'

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
5. 若指令无法执行（如列不存在），headers/rows 原样返回，并在 summary 中说明原因。`

const WORD_PROMPT_HEAD = `你是「Word 文档撰写助手」。请根据用户需求撰写文档内容，**只输出 Markdown 正文**，不要任何解释、前言或收尾寒暄。
要求：
1. 用规范 Markdown：# 一级标题、## 二级标题、- 无序列表、1. 有序列表、**加粗**；不要使用 HTML 标签。
2. 结构完整、层级清晰、用词正式；除非用户另有要求，使用中文。
3. 若用户给了参考材料，以材料为事实依据，不要虚构关键信息。`

// ── 阶段状态 ────────────────────────────────────────────────────────

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

export interface ExcelDiff {
  summary: string
  rowsBefore: number
  rowsAfter: number
  colsBefore: number
  colsAfter: number
}

interface OfficeStore {
  // 模型选择（三窗口共用；PPT 窗口用 artifactStore 自己的）
  aggModels: AggModel[]
  modelsLoaded: boolean
  currentModel: string
  currentProviderId: string | null
  loadModels: () => Promise<void>
  setModelSel: (providerId: string, modelId: string) => void

  // 流式进度（当前活跃请求的增量文本，供 UI 展示）
  streaming: boolean
  streamText: string
  stopActive: () => Promise<void>

  // ── Excel ──
  excelStage: ExcelStage
  excelFileName: string
  excelTable: TableData | null
  /** 最近一次模型修改后的差异简述。 */
  excelDiff: ExcelDiff | null
  excelError: string | null
  excelLoadFile: (file: File) => Promise<void>
  excelRun: (instruction: string) => Promise<void>
  excelDownload: () => Promise<void>
  excelReset: () => void

  // ── Word ──
  wordStage: WordStage
  wordMarkdown: string
  wordError: string | null
  wordGenerate: (requirement: string, reference: string) => Promise<void>
  wordDownload: () => Promise<void>
  wordReset: () => void
}

// ── 隐藏会话 + 独立 studio-event 监听（promise 化的一问一答） ─────────

interface PendingRun {
  sessionId: string
  buf: string
  resolve: (text: string) => void
  reject: (err: Error) => void
}

let pending: PendingRun | null = null
let listenerReady = false

async function ensureListener(
  onDelta: (buf: string) => void,
): Promise<void> {
  if (listenerReady || !isTauri) return
  listenerReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      if (!pending || !p.session_id || p.session_id !== pending.sessionId) return
      switch (p.type) {
        case 'delta':
          pending.buf += p.text ?? ''
          onDelta(pending.buf)
          break
        case 'done': {
          const r = pending
          pending = null
          r.resolve(p.text || r.buf)
          break
        }
        case 'error': {
          const r = pending
          pending = null
          r.reject(new Error(p.message ?? '生成出错'))
          break
        }
        default:
          break
      }
    })
  } catch (err) {
    listenerReady = false
    console.warn('[officeStore] failed to register studio-event listener:', err)
  }
}

export const useOfficeStore = create<OfficeStore>((set, get) => {
  /** 发起一轮模型调用：新建隐藏会话 → chat_send → 等 done/error。 */
  async function runChat(userContent: string, title: string): Promise<string> {
    if (!isTauri) throw new Error('模型调用仅在桌面应用内可用')
    if (pending) throw new Error('已有任务在处理中，请先等待或停止')
    const model = get().currentModel
    if (!model) throw new Error('尚未选择模型')
    await ensureListener((buf) => set({ streamText: buf }))

    // 每轮任务用全新隐藏会话：上下文自包含，避免历史消息拖大 token。
    const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
      title,
      model,
    })
    const sessionId = row.id

    set({ streaming: true, streamText: '' })
    const promise = new Promise<string>((resolve, reject) => {
      pending = { sessionId, buf: '', resolve, reject }
    })
    try {
      await tauriInvoke<string>('chat_send', {
        sessionId,
        userContent,
        attachments: [],
        model,
        providerId: get().currentProviderId ?? null,
      })
    } catch (e) {
      // TS 控制流不追踪 Promise executor 里的赋值，这里显式放宽回声明类型。
      if ((pending as PendingRun | null)?.sessionId === sessionId) pending = null
      set({ streaming: false })
      throw e instanceof Error ? e : new Error(String(e))
    }
    try {
      return await promise
    } finally {
      set({ streaming: false })
    }
  }

  return {
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

    streaming: false,
    streamText: '',

    stopActive: async () => {
      const sid = pending?.sessionId
      if (!sid) return
      try {
        await tauriInvoke<void>('chat_stop', { sessionId: sid })
      } catch (e) {
        console.warn('[officeStore] stop failed:', e)
      }
    },

    // ── Excel ──────────────────────────────────────────────────────

    excelStage: 'idle',
    excelFileName: '',
    excelTable: null,
    excelDiff: null,
    excelError: null,

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

    excelRun: async (instruction) => {
      const instr = instruction.trim()
      const { excelTable, excelStage, streaming } = get()
      if (!instr || !excelTable || streaming) return
      if (excelStage !== 'ready' && excelStage !== 'done') return
      const prevStage = excelStage
      const before = excelTable
      const { json, truncatedNote } = serializeTableForModel(before)
      const userContent =
        `${EXCEL_PROMPT_HEAD}\n\n———\n表格数据（JSON）${truncatedNote}：\n${json}\n\n` +
        `———\n用户指令：${instr}`
      set({ excelStage: 'processing', excelError: null, excelDiff: null })
      try {
        const reply = await runChat(userContent, 'Office · Excel 处理')
        const parsed = parseTableResult(reply)
        if (!parsed) {
          set({
            excelStage: prevStage,
            excelError: '模型没有返回有效的表格 JSON，请重试或换个说法/模型',
          })
          return
        }
        set({
          excelStage: 'done',
          excelTable: parsed.table,
          excelDiff: {
            summary: parsed.summary || '（模型未提供修改说明）',
            rowsBefore: before.rows.length,
            rowsAfter: parsed.table.rows.length,
            colsBefore: before.headers.length,
            colsAfter: parsed.table.headers.length,
          },
        })
      } catch (e) {
        set({
          excelStage: prevStage,
          excelError: `处理失败：${e instanceof Error ? e.message : String(e)}`,
        })
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
      }),

    // ── Word ───────────────────────────────────────────────────────

    wordStage: 'idle',
    wordMarkdown: '',
    wordError: null,

    wordGenerate: async (requirement, reference) => {
      const req = requirement.trim()
      if (!req || get().streaming) return
      const prev = get().wordMarkdown
      const refBlock = reference.trim()
        ? `\n\n———\n参考材料：\n${reference.trim()}`
        : ''
      // done 之后再提需求 = 在现有文稿基础上改写。
      const prevBlock =
        get().wordStage === 'done' && prev
          ? `\n\n———\n当前文稿（Markdown，请在此基础上按需求修改后输出完整新版）：\n${prev}`
          : ''
      const userContent = `${WORD_PROMPT_HEAD}\n\n———\n用户需求：${req}${refBlock}${prevBlock}`
      set({ wordStage: 'generating', wordError: null })
      try {
        const reply = await runChat(userContent, 'Office · Word 文档')
        const md = extractMarkdown(reply)
        if (!md) {
          set({
            wordStage: prev ? 'done' : 'idle',
            wordError: '模型没有返回内容，请重试',
          })
          return
        }
        set({ wordStage: 'done', wordMarkdown: md })
      } catch (e) {
        set({
          wordStage: prev ? 'done' : 'idle',
          wordError: `生成失败：${e instanceof Error ? e.message : String(e)}`,
        })
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
      set({ wordStage: 'idle', wordMarkdown: '', wordError: null }),
  }
})

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
