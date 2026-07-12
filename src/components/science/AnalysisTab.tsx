/**
 * AnalysisTab -- 文献分析工作台(科研板块)
 *
 * 布局: 左=已选文献列表(切换当前篇) | 中=原文预览 | 右=针对当前篇的提问对话 + 报告。
 *
 * 原文预览:
 * - 知识库里有本地 PDF -> pdfjs 渲染(kb_read_bytes 读字节,同 LibraryTab.KbPdfPreview),
 *   并自绘透明文本层(getTextContent 逐 item 定位)支持浏览器原生选区;
 * - 只有元数据+链接(.md 条目或纯搜索结果)-> 摘要卡,提示下载 PDF 后在知识库补入。
 *
 * 划线高亮(真实档位说明): 选区 ClientRects 归一化为页面相对坐标(0..1),
 * 缩放后仍精确 overlay 在 PDF 上;同时收集「选中文本+页码」高亮笔记列表。
 * 持久化在 scienceStore(localStorage),供提问与生成报告时引用。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import MarkdownLite from '../ui/MarkdownLite'
import { Mascot } from '../ui'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import {
  useScienceStore,
  safeFileStem,
  kbReadText,
  type SciPaperRef,
  type SciHighlight,
} from '../../stores/scienceStore'
import { saveExport } from '../../lib/exportChat'

/** Lazy-init pdfjs worker (avoids module-level side-effect crash -> white screen). */
let _workerReady = false
async function ensurePdfjsWorker(): Promise<void> {
  if (_workerReady) return
  try {
    const mod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = mod.default
  } catch (e) {
    console.warn('[AnalysisTab] pdfjs worker setup failed:', e)
  }
  _workerReady = true
}

const BSLASH = String.fromCharCode(92)

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
const MAX_PAGES = 60
const HIGHLIGHT_COLORS = ['#ffd54d', '#7bdc9a', '#8ec9ff', '#ffb3c8']

async function openExternal(url: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url })
  } catch (e) {
    console.warn('[AnalysisTab] openExternal failed:', e)
  }
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf(BSLASH))
  return p.slice(i + 1)
}

async function kbReadPdfData(paperId: string): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core')
  const res = await invoke<{ base64: string; size: number }>('kb_read_bytes', {
    id: paperId,
  })
  const bin = atob(res.base64)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  return data
}

// ── PDF 页(canvas + 透明文本层 + 高亮 overlay) ─────────────────────────────

function AnalysisPdfPage({
  doc,
  pageNo,
  scale,
  highlights,
}: {
  doc: PDFDocumentProxy
  pageNo: number
  scale: number
  highlights: SciHighlight[]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    ;(async () => {
      try {
        const page: PDFPageProxy = await doc.getPage(pageNo)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const vp = page.getViewport({ scale })
        canvas.width = Math.floor(vp.width * dpr)
        canvas.height = Math.floor(vp.height * dpr)
        canvas.style.width = Math.floor(vp.width) + 'px'
        canvas.style.height = Math.floor(vp.height) + 'px'
        setSize({ w: Math.floor(vp.width), h: Math.floor(vp.height) })
        task = page.render({
          canvas,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        })
        await task.promise

        // 透明文本层:逐 TextItem 绝对定位,浏览器原生选区可用。
        const textDiv = textRef.current
        if (!textDiv || cancelled) return
        textDiv.replaceChildren()
        const tc = await page.getTextContent()
        if (cancelled) return
        const spans: { el: HTMLSpanElement; target: number }[] = []
        for (const item of tc.items) {
          if (!('str' in item) || !item.str) continue
          const tx = pdfjs.Util.transform(vp.transform, item.transform)
          const fontH = Math.hypot(tx[2], tx[3])
          if (fontH <= 0) continue
          const el = document.createElement('span')
          el.textContent = item.str
          el.style.position = 'absolute'
          el.style.left = tx[4] + 'px'
          el.style.top = tx[5] - fontH + 'px'
          el.style.fontSize = fontH + 'px'
          el.style.fontFamily = 'sans-serif'
          el.style.lineHeight = '1'
          el.style.whiteSpace = 'pre'
          el.style.color = 'transparent'
          el.style.transformOrigin = '0% 0%'
          el.style.cursor = 'text'
          textDiv.appendChild(el)
          spans.push({ el, target: item.width * scale })
        }
        // 水平缩放对齐:量实际宽度后 scaleX 到 PDF 声明宽度。
        for (const { el, target } of spans) {
          const actual = el.getBoundingClientRect().width
          if (actual > 0 && target > 0) {
            el.style.transform = 'scaleX(' + target / actual + ')'
          }
        }
      } catch {
        /* render cancelled */
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
      textRef.current?.replaceChildren()
    }
  }, [doc, pageNo, scale])

  const pageHls = highlights.filter((h) => h.page === pageNo)

  return (
    <div
      data-sci-page={pageNo}
      className="relative flex-shrink-0 bg-white border border-line shadow-lg"
      style={size ? { width: size.w + 'px', height: size.h + 'px' } : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      {pageHls.map((h) =>
        h.rects.map((r, i) => (
          <div
            key={h.id + ':' + i}
            className="absolute pointer-events-none"
            style={{
              left: r.x * 100 + '%',
              top: r.y * 100 + '%',
              width: r.w * 100 + '%',
              height: r.h * 100 + '%',
              backgroundColor: h.color,
              opacity: 0.35,
              mixBlendMode: 'multiply',
            }}
          />
        )),
      )}
      <div ref={textRef} className="absolute inset-0 overflow-hidden select-text" />
    </div>
  )
}

// ── PDF 预览器(工具条: 缩放 + 高亮颜色 + 添加高亮) ─────────────────────────

function AnalysisPdfViewer({ paper }: { paper: SciPaperRef }) {
  const highlights = useScienceStore((s) => s.highlights[paper.key] ?? [])
  const addHighlight = useScienceStore((s) => s.addHighlight)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageWidth, setPageWidth] = useState(612)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [boxWidth, setBoxWidth] = useState(0)
  const [color, setColor] = useState(HIGHLIGHT_COLORS[0])
  const [hlMsg, setHlMsg] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    setBoxWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    let loaded: PDFDocumentProxy | null = null
    setDoc(null)
    setError(null)
    setZoom('fit')
    if (!paper.kbId) return
    ;(async () => {
      try {
        await ensurePdfjsWorker()
        const data = await kbReadPdfData(paper.kbId as string)
        if (!alive) return
        loaded = await pdfjs.getDocument({ data }).promise
        if (!alive) {
          void loaded.loadingTask.destroy()
          return
        }
        const p1 = await loaded.getPage(1)
        if (!alive) return
        setPageWidth(p1.getViewport({ scale: 1 }).width)
        setDoc(loaded)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => {
      alive = false
      if (loaded) void loaded.loadingTask.destroy()
    }
  }, [paper.kbId])

  const fitScale = Math.min(Math.max((boxWidth - 48) / pageWidth, 0.3), 3)
  const scale = zoom === 'fit' ? fitScale : zoom
  const zoomBy = (dir: 1 | -1) => {
    const next =
      dir === 1
        ? ZOOM_STEPS.find((z) => z > scale * 1.01)
        : [...ZOOM_STEPS].reverse().find((z) => z < scale * 0.99)
    if (next) setZoom(next)
  }

  /** 把当前浏览器选区变成高亮:文本 + 页码 + 归一化矩形。 */
  const captureHighlight = () => {
    setHlMsg(null)
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setHlMsg('请先在 PDF 页面上选中一段文本')
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      setHlMsg('请先在 PDF 页面上选中一段文本')
      return
    }
    const range = sel.getRangeAt(0)
    let node: Node | null = range.startContainer
    let pageEl: HTMLElement | null = null
    while (node) {
      if (node instanceof HTMLElement && node.dataset.sciPage) {
        pageEl = node
        break
      }
      node = node.parentNode
    }
    if (!pageEl) {
      setHlMsg('选区不在 PDF 页面内')
      return
    }
    const pageNo = parseInt(pageEl.dataset.sciPage ?? '0', 10)
    const pr = pageEl.getBoundingClientRect()
    const rects: { x: number; y: number; w: number; h: number }[] = []
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue
      const x1 = Math.max(r.left, pr.left)
      const y1 = Math.max(r.top, pr.top)
      const x2 = Math.min(r.right, pr.right)
      const y2 = Math.min(r.bottom, pr.bottom)
      if (x2 <= x1 || y2 <= y1) continue
      rects.push({
        x: (x1 - pr.left) / pr.width,
        y: (y1 - pr.top) / pr.height,
        w: (x2 - x1) / pr.width,
        h: (y2 - y1) / pr.height,
      })
    }
    addHighlight(paper.key, { page: pageNo, text: text.slice(0, 2000), color, rects })
    sel.removeAllRanges()
    setHlMsg('已添加高亮(第 ' + pageNo + ' 页)')
  }

  const numPages = doc?.numPages ?? 0
  const shownPages = Math.min(numPages, MAX_PAGES)
  const btn =
    'px-2 h-6 rounded border border-line text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors'

  return (
    <div className="w-full h-full flex flex-col bg-editor">
      <div className="flex items-center gap-1.5 px-3 h-9 border-b border-line bg-surface/60 flex-shrink-0 select-none">
        <span className="text-[11px] text-ink-dim truncate flex-1 min-w-0">
          {doc
            ? '共 ' + numPages + ' 页' + (numPages > MAX_PAGES ? '(仅渲染前 ' + MAX_PAGES + ' 页)' : '')
            : ''}
        </span>
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={
              'w-4 h-4 rounded-full border flex-shrink-0 ' +
              (color === c ? 'border-ink scale-110' : 'border-line')
            }
            style={{ backgroundColor: c }}
            title="高亮颜色"
          />
        ))}
        <button className={btn} onClick={captureHighlight} title="选中 PDF 文本后点击">
          添加高亮
        </button>
        <button className={btn} onClick={() => zoomBy(-1)}>-</button>
        <span className="text-[11px] text-ink-muted w-10 text-center font-mono">
          {Math.round(scale * 100)}%
        </span>
        <button className={btn} onClick={() => zoomBy(1)}>+</button>
        <button
          className={[btn, zoom === 'fit' ? 'border-primary/40 text-primary' : ''].join(' ')}
          onClick={() => setZoom('fit')}
        >
          适应宽
        </button>
      </div>
      {hlMsg && (
        <div className="px-3 py-1 text-[11px] text-ink-muted border-b border-line/60 flex-shrink-0">
          {hlMsg}
        </div>
      )}
      <div ref={boxRef} className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="w-full h-full flex items-center justify-center px-6 text-center">
            <p className="text-[12px] text-failed">PDF 加载失败: {error}</p>
          </div>
        ) : !doc ? (
          <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
            解析中...
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4 px-3">
            {Array.from({ length: shownPages }, (_, i) => (
              <AnalysisPdfPage
                key={paper.key + ':' + (i + 1)}
                doc={doc}
                pageNo={i + 1}
                scale={scale}
                highlights={highlights}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 摘要卡(无本地 PDF: .md 条目或纯搜索结果) ────────────────────────────────

function AbstractCard({ paper }: { paper: SciPaperRef }) {
  const [entryMd, setEntryMd] = useState<string | null>(null)
  const isMdEntry = !!paper.kbId && !!paper.filePath && !paper.isPdf

  useEffect(() => {
    let alive = true
    setEntryMd(null)
    if (!isMdEntry || !paper.kbId) return
    ;(async () => {
      try {
        const text = await kbReadText(paper.kbId as string)
        if (alive) setEntryMd(text)
      } catch {
        if (alive) setEntryMd(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [paper.kbId, isMdEntry])

  return (
    <div className="w-full h-full overflow-y-auto bg-editor px-4 py-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <div className="bg-surface border border-line rounded-card shadow-card p-4">
          <h2 className="text-[14px] font-semibold text-ink leading-6">{paper.title}</h2>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11.5px] text-ink-dim">
            {paper.authors && <span>{paper.authors}</span>}
            {paper.year && <span>{paper.year}</span>}
            {paper.venue && <span>{paper.venue}</span>}
            {paper.doi && <span className="font-mono">{paper.doi}</span>}
          </div>
          {paper.url && (
            <button
              onClick={() => void openExternal(paper.url)}
              className="mt-2 text-[11.5px] px-2.5 py-1 rounded-md bg-surface-2 border border-line text-ink-muted hover:text-primary hover:border-primary/60 transition-colors"
            >
              打开原文链接 ↗
            </button>
          )}
        </div>

        {entryMd ? (
          <div className="bg-surface border border-line rounded-card shadow-card p-4">
            <MarkdownLite text={entryMd} />
          </div>
        ) : paper.abstract ? (
          <div className="bg-surface border border-line rounded-card shadow-card p-4">
            <h3 className="text-[12px] font-semibold text-ink mb-1.5">摘要</h3>
            <p className="text-[12.5px] text-ink-muted leading-6 whitespace-pre-wrap">
              {paper.abstract}
            </p>
          </div>
        ) : null}

        <p className="text-[11px] text-ink-dim leading-5">
          该条目暂无本地 PDF,预览与划线不可用;提问与报告将基于元数据/摘要。
          下载 PDF 后在「知识库」上传补入,再从知识库重新送入分析即可获得全文能力。
        </p>
      </div>
    </div>
  )
}

// ── 高亮笔记列表 ─────────────────────────────────────────────────────────────

function HighlightList({ paperKey }: { paperKey: string }) {
  const highlights = useScienceStore((s) => s.highlights[paperKey] ?? [])
  const removeHighlight = useScienceStore((s) => s.removeHighlight)
  const [open, setOpen] = useState(true)
  if (highlights.length === 0) return null
  return (
    <div className="border-t border-line flex-shrink-0 bg-surface/40 max-h-[30%] flex flex-col">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 text-[11.5px] text-ink-muted hover:text-ink text-left flex items-center gap-1.5 flex-shrink-0"
      >
        <span>{open ? '▾' : '▸'}</span>
        高亮笔记({highlights.length})
      </button>
      {open && (
        <div className="overflow-y-auto px-3 pb-2 space-y-1.5">
          {highlights.map((h) => (
            <div key={h.id} className="flex items-start gap-2 text-[11.5px] group">
              <span
                className="w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0"
                style={{ backgroundColor: h.color }}
              />
              <span className="text-ink-dim flex-shrink-0">P{h.page}</span>
              <span className="flex-1 text-ink-muted leading-5 break-words">{h.text}</span>
              <button
                onClick={() => removeHighlight(paperKey, h.id)}
                className="text-ink-dim hover:text-failed opacity-0 group-hover:opacity-100 flex-shrink-0"
                title="删除高亮"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 左列:已选文献列表 ────────────────────────────────────────────────────────

function PaperListPane() {
  const papers = useScienceStore((s) => s.analysisPapers)
  const currentKey = useScienceStore((s) => s.currentKey)
  const setCurrentPaper = useScienceStore((s) => s.setCurrentPaper)
  const removeAnalysisPaper = useScienceStore((s) => s.removeAnalysisPaper)
  const reports = useScienceStore((s) => s.reports)

  return (
    <div className="w-56 flex-shrink-0 border-r border-line flex flex-col bg-surface/20">
      <div className="px-3 py-2 text-[11px] text-ink-dim border-b border-line/60 flex-shrink-0">
        已选文献({papers.length})
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {papers.map((p) => {
          const active = p.key === currentKey
          const hasReport = !!reports[p.key]?.md
          return (
            <div
              key={p.key}
              onClick={() => setCurrentPaper(p.key)}
              className={
                'group px-3 py-2 cursor-pointer border-l-2 transition-colors ' +
                (active
                  ? 'border-primary bg-primary-tint/50'
                  : 'border-transparent hover:bg-surface-2/60')
              }
            >
              <div className="flex items-start gap-1">
                <span
                  className={
                    'flex-1 text-[12px] leading-5 break-words ' +
                    (active ? 'text-primary font-medium' : 'text-ink')
                  }
                >
                  {p.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeAnalysisPaper(p.key)
                  }}
                  className="text-ink-dim hover:text-failed opacity-0 group-hover:opacity-100 flex-shrink-0 text-[11px]"
                  title="移出工作台"
                >
                  ✕
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                {p.year && <span className="text-ink-dim">{p.year}</span>}
                <span
                  className={
                    'px-1 py-px rounded ' +
                    (p.isPdf
                      ? 'bg-[#10a37f1a] text-done'
                      : 'bg-surface-2 text-ink-dim')
                  }
                >
                  {p.isPdf ? 'PDF' : p.kbId ? '条目' : '未入库'}
                </span>
                {hasReport && (
                  <span className="px-1 py-px rounded bg-primary-tint text-primary">已出报告</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 右列:提问对话 + 报告 ─────────────────────────────────────────────────────

function ChatPane({ paper }: { paper: SciPaperRef }) {
  const chat = useScienceStore((s) => s.chats[paper.key])
  const report = useScienceStore((s) => s.reports[paper.key])
  const fulltext = useScienceStore((s) => s.fulltexts[paper.key])
  const ask = useScienceStore((s) => s.ask)
  const stopChat = useScienceStore((s) => s.stopChat)
  const generateReport = useScienceStore((s) => s.generateReport)
  const syncReportToKb = useScienceStore((s) => s.syncReportToKb)
  const [input, setInput] = useState('')
  const [showReport, setShowReport] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const messages = chat?.messages ?? []
  const streaming = chat?.streaming ?? false

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, chat?.streamText])

  const send = () => {
    const q = input.trim()
    if (!q || streaming) return
    setInput('')
    void ask(paper.key, q)
  }

  const toolBtn =
    'text-[11.5px] px-2.5 py-1 rounded-md bg-surface-2 border border-line text-ink hover:bg-elevated transition-colors disabled:opacity-40'

  return (
    <div className="w-[380px] flex-shrink-0 border-l border-line flex flex-col bg-surface/20">
      <div className="px-3 py-2 border-b border-line/60 flex-shrink-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink flex-1 truncate">提问对话</span>
          <button
            onClick={() => void generateReport(paper.key)}
            disabled={report?.generating}
            className="text-[11.5px] px-2.5 py-1 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            {report?.generating ? '报告生成中…' : report?.md ? '重新生成报告' : '生成 .md 分析报告'}
          </button>
          {(report?.md || report?.generating) && (
            <button onClick={() => setShowReport(true)} className={toolBtn}>
              查看
            </button>
          )}
        </div>
        {fulltext && (
          <p className="text-[10.5px] text-ink-dim leading-4">资料级别: {fulltext.note}</p>
        )}
        {report?.error && <p className="text-[11px] text-failed">{report.error}</p>}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2.5">
        {messages.length === 0 && !streaming && (
          <p className="text-[11.5px] text-ink-dim leading-5 pt-2">
            针对当前论文自由提问(多轮,上下文保留)。首轮会把论文资料
            (本地 PDF 提取全文或元数据/摘要)交给模型。
          </p>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] bg-primary-tint text-ink rounded-lg px-3 py-1.5 text-[12px] leading-5 whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="bg-surface border border-line rounded-lg px-3 py-2">
              <MarkdownLite text={m.content} />
            </div>
          ),
        )}
        {streaming && (
          <div className="bg-surface border border-line rounded-lg px-3 py-2">
            {chat?.streamText ? (
              <MarkdownLite text={chat.streamText} />
            ) : (
              <span className="text-[11.5px] text-ink-dim">思考中…</span>
            )}
          </div>
        )}
        {chat?.error && <p className="text-[11.5px] text-failed">{chat.error}</p>}
      </div>

      <div className="border-t border-line px-3 py-2 flex-shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
          placeholder="针对当前论文提问(Enter 发送,Shift+Enter 换行)"
          className="w-full bg-surface border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors resize-none"
        />
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10.5px] text-ink-dim flex-1">
            {(useScienceStore.getState().highlights[paper.key] ?? []).length > 0
              ? '生成报告时会带上你的高亮与问答'
              : ''}
          </span>
          {streaming && (
            <button onClick={() => void stopChat(paper.key)} className={toolBtn}>
              停止
            </button>
          )}
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="text-[12px] px-3.5 py-1 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            发送
          </button>
        </div>
      </div>

      {showReport && (
        <div className="fixed inset-0 z-50 flex bg-black/40" onClick={() => setShowReport(false)}>
          <div
            className="ml-auto h-full w-full max-w-2xl bg-bg border-l border-line flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
              <span className="text-[13px] font-semibold text-ink flex-1 truncate">
                分析报告 · {paper.title}
              </span>
              {report?.md && !report.generating && (
                <>
                  <button
                    onClick={() =>
                      void saveExport(
                        '分析报告_' + safeFileStem(paper.title, paper.year),
                        'md',
                        report.md,
                      )
                    }
                    className={toolBtn}
                  >
                    导出 .md
                  </button>
                  <button onClick={() => void syncReportToKb(paper.key)} className={toolBtn}>
                    同步知识库
                  </button>
                </>
              )}
              <button
                onClick={() => setShowReport(false)}
                className="text-ink-dim hover:text-ink text-lg leading-none px-1"
              >
                ✕
              </button>
            </div>
            {report?.savedPath && (
              <div className="px-4 py-1.5 text-[11px] text-done border-b border-line/60 flex-shrink-0 break-all">
                已同步: {baseName(report.savedPath)}(analyzed=1,路径 {report.savedPath})
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              {report?.md ? (
                <MarkdownLite text={report.md} />
              ) : (
                <p className="text-[12px] text-ink-dim">报告生成中…</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 主组件 ───────────────────────────────────────────────────────────────────

export default function AnalysisTab() {
  const papers = useScienceStore((s) => s.analysisPapers)
  const currentKey = useScienceStore((s) => s.currentKey)
  const modelKey = useScienceStore((s) => s.modelKey)
  const setModelKey = useScienceStore((s) => s.setModelKey)
  const setActiveTab = useScienceStore((s) => s.setActiveTab)
  const ensureFulltext = useScienceStore((s) => s.ensureFulltext)

  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)
  const loadModels = useWorkbenchStore((s) => s.loadModels)

  useEffect(() => {
    if (!modelsLoaded) void loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const chatModels = useMemo(
    () => aggModels.filter((m) => (m.kind ?? 'chat') === 'chat'),
    [aggModels],
  )

  useEffect(() => {
    if (!modelKey && chatModels.length > 0) {
      const preferred = chatModels.find((m) => m.modelId === 'gpt-5.5') ?? chatModels[0]
      setModelKey(preferred.providerId + '|' + preferred.modelId)
    }
  }, [chatModels, modelKey, setModelKey])

  const current = papers.find((p) => p.key === currentKey) ?? null

  // 切到某篇时后台预热全文提取(提问/报告都会用到)。
  useEffect(() => {
    if (current) void ensureFulltext(current.key)
  }, [current?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (papers.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center px-8">
        <Mascot mood="idle" size={64} className="mb-3" />
        <p className="text-ink-muted text-sm">文献分析工作台还没有论文</p>
        <p className="text-ink-dim text-xs mt-1.5 leading-5 max-w-md">
          在「文献搜索」勾选若干篇后点「进入文献分析」,
          或在「知识库」勾选已有条目送入。支持逐篇预览原文、划线高亮、
          针对性提问,并生成 .md 分析报告同步回知识库。
        </p>
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setActiveTab('lit')}
            className="text-[12px] px-3.5 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors"
          >
            去文献搜索
          </button>
          <button
            onClick={() => setActiveTab('library')}
            className="text-[12px] px-3.5 py-1.5 rounded-md bg-surface-2 border border-line text-ink hover:bg-elevated transition-colors"
          >
            去知识库
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 border-b border-line/60 flex-shrink-0 flex items-center gap-2">
        <span className="text-[11px] text-ink-dim">分析模型</span>
        <select
          value={modelKey}
          onChange={(e) => setModelKey(e.target.value)}
          className="bg-surface border border-line rounded-lg px-2 py-1 text-[12px] text-ink focus:outline-none focus:border-primary transition-colors max-w-[300px]"
        >
          {chatModels.length === 0 && <option value="">无可用模型</option>}
          {chatModels.map((m) => (
            <option key={m.providerId + '|' + m.modelId} value={m.providerId + '|' + m.modelId}>
              {m.providerLabel} · {m.modelId}
            </option>
          ))}
        </select>
        {modelsLoaded && chatModels.length === 0 && (
          <span className="text-[11px] text-ink-dim">
            请先在「设置」添加 OpenAI 兼容服务商
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <PaperListPane />
        <div className="flex-1 min-w-0 flex flex-col">
          {current ? (
            <>
              <div className="flex-1 min-h-0">
                {current.isPdf && current.kbId ? (
                  <AnalysisPdfViewer paper={current} />
                ) : (
                  <AbstractCard paper={current} />
                )}
              </div>
              <HighlightList paperKey={current.key} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-ink-dim">
              在左侧选择一篇文献
            </div>
          )}
        </div>
        {current && <ChatPane paper={current} />}
      </div>
    </div>
  )
}
