/**
 * LitSearchTab -- 文献搜索 + AI 分析（科研板块）
 *
 * 自 698a026 的 Research.tsx 恢复并升级：
 * - 搜索源：arXiv / IACR ePrint / DBLP（九大密码学与安全顶会顶刊，多选 venue）/ OpenAlex
 * - 分析模型选择器：只读消费 workbenchStore.aggModels（chat 模型聚合），默认 gpt-5.5
 * - 分析过程可视化：lit_analyze 是一次性后端调用（无流式/分段事件，见 litsearch.rs），
 *   因此阶段进度为「乐观估计动画 + 真实耗时计时」，完成后显示真实总耗时
 * - 分析产物 Markdown 应用内预览 + 导出 .md（saveExport）
 * - 勾选文献一键入库：kb.rs 无纯元数据命令、也无 PDF 下载命令，故生成
 *   「元数据 + 链接」的 .md 条目文件写入 kb_root/lit-inbox/（export_text_file），
 *   再以 kb_upload_paper(mode="index") 登记并回填元数据
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Mascot } from '../ui'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import {
  useResearchStore,
  type LitPaper,
  type LitAnalyzeResult,
  type LitPaperExtras,
  type LitFigure,
} from '../../stores/researchStore'
import { useKbStore } from '../../stores/kbStore'
import { useScienceStore } from '../../stores/scienceStore'
import { saveExport } from '../../lib/exportChat'

const NL = String.fromCharCode(10)

const CARD =
  'bg-surface border border-line rounded-card shadow-card transition-all duration-150'

const DEFAULT_ANALYZE_INSTRUCTION =
  '按标准模板逐篇详细分析这些文献，并给出横向对比与研究缺口'
const LIT_REMARK_PLUGINS = [remarkGfm]

/** 在系统浏览器打开链接（永不在 webview 内跳转）。 */
async function openExternal(url: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url })
  } catch (e) {
    console.warn('[Science] openExternal failed:', e)
  }
}

const litMdComponents: Components = {
  p: ({ children }) => <p className="my-2 leading-6">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-6">{children}</li>,
  h1: ({ children }) => (
    <h1 className="text-[16px] font-semibold mt-4 mb-2 text-ink">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[14.5px] font-semibold mt-4 mb-2 text-ink">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[13.5px] font-semibold mt-3 mb-1.5 text-ink">{children}</h3>
  ),
  code: ({ children }) => (
    <code className="px-1 py-0.5 rounded bg-surface-2 text-[0.9em] font-mono">
      {children}
    </code>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 my-2 text-ink-muted">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 bg-surface text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        if (href) {
          e.preventDefault()
          void openExternal(href)
        }
      }}
      className="text-primary underline underline-offset-2 cursor-pointer"
    >
      {children}
    </a>
  ),
}

function LitMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[12.5px] text-ink break-words">
      <ReactMarkdown remarkPlugins={LIT_REMARK_PLUGINS} components={litMdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** 单张论文图：加载失败时退化为 caption + 原始链接。 */
function LitFigureView({ fig }: { fig: LitFigure }) {
  const [failed, setFailed] = useState(false)
  return (
    <figure className="my-2">
      {failed ? (
        <button
          onClick={() => void openExternal(fig.url)}
          className="text-[11.5px] text-primary underline underline-offset-2 text-left break-all"
        >
          图片加载失败，点击在浏览器打开：{fig.url}
        </button>
      ) : (
        <img
          src={fig.url}
          alt={fig.caption || '论文图片'}
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-w-full rounded-lg border border-line bg-white"
        />
      )}
      {fig.caption && (
        <figcaption className="text-[11px] text-ink-dim leading-4 mt-1">
          {fig.caption}
        </figcaption>
      )}
    </figure>
  )
}

/** 分析结果尾部：逐篇内联展示抓到的图表与开源代码链接。 */
function FigureAppendix({ papers }: { papers: LitPaperExtras[] }) {
  if (!papers.some((p) => p.figures.length > 0 || p.code_links.length > 0)) {
    return null
  }
  return (
    <div className="border-t border-line pt-3 mt-4">
      <h2 className="text-[14px] font-semibold text-ink mb-2">论文图表与代码链接</h2>
      {papers.map((p, i) =>
        p.figures.length === 0 && p.code_links.length === 0 ? null : (
          <section key={i} className="mb-5">
            <h3 className="text-[12.5px] font-semibold text-ink mb-1.5">
              [{i + 1}] {p.title}
              {p.note && (
                <span className="ml-2 text-[10.5px] font-normal text-ink-dim">
                  {p.note}
                </span>
              )}
            </h3>
            {p.code_links.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {p.code_links.map((l) => (
                  <button
                    key={l}
                    onClick={() => void openExternal(l)}
                    className="text-[10.5px] px-2 py-0.5 rounded bg-surface-2 border border-line text-ink-muted hover:text-primary hover:border-primary/60 transition-colors font-mono"
                    title={l}
                  >
                    {l.replace('https://', '')}
                  </button>
                ))}
              </div>
            )}
            {p.figures.map((f, j) => (
              <LitFigureView key={j} fig={f} />
            ))}
          </section>
        ),
      )}
    </div>
  )
}

/** 导出用完整 Markdown：分析正文 + 图表/代码链接附录。 */
function analysisToMarkdown(r: LitAnalyzeResult): string {
  const sections: string[] = []
  r.papers.forEach((p, i) => {
    const lines: string[] = []
    if (p.note) lines.push('资料级别: ' + p.note)
    if (p.code_links.length > 0) lines.push('代码链接: ' + p.code_links.join(' , '))
    for (const f of p.figures) {
      lines.push('![' + (f.caption || '图') + '](' + f.url + ')')
    }
    if (lines.length > 0) {
      sections.push('### [' + (i + 1) + '] ' + p.title + NL + NL + lines.join(NL + NL))
    }
  })
  if (sections.length === 0) return r.analysis
  return (
    r.analysis +
    NL + NL + '---' + NL + NL +
    '## 附录：图表与代码链接' + NL + NL +
    sections.join(NL + NL)
  )
}

const LIT_SOURCE_LABEL: Record<string, string> = {
  arxiv: 'arXiv',
  openalex: 'OpenAlex',
  dblp: 'DBLP',
  eprint: 'IACR ePrint',
}

/** 与 Rust litsearch::DBLP_VENUES 对齐的九大密码学/安全顶会顶刊。 */
const DBLP_VENUES: { key: string; label: string }[] = [
  { key: 'crypto', label: 'CRYPTO' },
  { key: 'eurocrypt', label: 'EUROCRYPT' },
  { key: 'asiacrypt', label: 'ASIACRYPT' },
  { key: 'sp', label: 'S&P' },
  { key: 'ccs', label: 'CCS' },
  { key: 'uss', label: 'USENIX Sec' },
  { key: 'ndss', label: 'NDSS' },
  { key: 'tifs', label: 'TIFS' },
  { key: 'tdsc', label: 'TDSC' },
]

// -- 一键入库（元数据 + 链接 .md 条目） ----------------------------------------

/** Windows 安全文件名：去非法字符、压缩空白、限长。 */
function safeStubName(p: LitPaper): string {
  const base = (p.year ? p.year + '_' : '') + p.title
  return (
    base
      .replace(/[\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled'
  )
}

function paperStubMarkdown(p: LitPaper): string {
  const lines: string[] = []
  lines.push('# ' + p.title)
  lines.push('')
  if (p.authors.length > 0) lines.push('- 作者: ' + p.authors.join(', '))
  if (p.year) lines.push('- 年份: ' + p.year)
  lines.push('- 来源: ' + (p.venue || LIT_SOURCE_LABEL[p.source] || p.source))
  if (p.doi) lines.push('- DOI: ' + p.doi)
  if (p.url) lines.push('- 原文链接: <' + p.url + '>')
  if (p.abstract) {
    lines.push('')
    lines.push('## 摘要')
    lines.push('')
    lines.push(p.abstract)
  }
  lines.push('')
  lines.push('> 该条目由「文献搜索」一键入库生成：仅保存元数据与链接（后端无 PDF 下载通道），')
  lines.push('> 点击原文链接下载 PDF 后，可在知识库中「上传论文」补入正文。')
  lines.push('')
  return lines.join(NL)
}

// -- 分析阶段进度（乐观动画 + 真实计时） ----------------------------------------

const ANALYZE_STAGES = [
  '拉取开放版全文 / 图表 / 代码链接',
  '逐篇结构化分析',
  '汇总与横向对比',
] as const

function AnalyzeProgress({
  stageIdx,
  elapsed,
  paperCount,
}: {
  stageIdx: number
  elapsed: number
  paperCount: number
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink font-medium">
          正在分析 {paperCount} 篇文献
        </span>
        <span className="text-[11px] text-ink-dim font-mono">已用 {elapsed}s</span>
      </div>
      <div className="space-y-1.5">
        {ANALYZE_STAGES.map((label, i) => {
          const state = i < stageIdx ? 'done' : i === stageIdx ? 'running' : 'pending'
          return (
            <div key={label} className="flex items-center gap-2">
              {state === 'done' ? (
                <span className="w-4 h-4 flex items-center justify-center text-done text-[11px]">✓</span>
              ) : state === 'running' ? (
                <span className="w-4 h-4 flex items-center justify-center">
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                </span>
              ) : (
                <span className="w-4 h-4 flex items-center justify-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-line-strong" />
                </span>
              )}
              <span
                className={
                  'text-[12px] ' +
                  (state === 'done'
                    ? 'text-ink-muted line-through decoration-line-strong'
                    : state === 'running'
                      ? 'text-ink'
                      : 'text-ink-dim')
                }
              >
                {label}
              </span>
            </div>
          )
        })}
      </div>
      <p className="text-[10.5px] text-ink-dim leading-4">
        后端为一次性调用（无分段事件），阶段为估计进度，耗时为真实计时。
        全文抓取 + 详细报告较慢，勾选越多越久，请耐心等待。
      </p>
    </div>
  )
}

// -- 结果卡片 -------------------------------------------------------------------

function PaperCard({
  paper,
  checked,
  onToggle,
}: {
  paper: LitPaper
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div
      className={
        CARD +
        ' p-3.5 flex gap-3 cursor-pointer ' +
        (checked ? 'border-primary/70 bg-primary-tint/40' : 'hover:border-line-strong')
      }
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 h-4 w-4 accent-primary flex-shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink font-semibold leading-5">{paper.title}</div>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-tint text-primary font-medium flex-shrink-0">
            {LIT_SOURCE_LABEL[paper.source] ?? paper.source}
          </span>
          {paper.venue && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#10a37f1a] text-done font-medium flex-shrink-0">
              {paper.venue}
            </span>
          )}
          {paper.year && <span className="text-[10.5px] text-ink-dim">{paper.year}</span>}
          {paper.authors.length > 0 && (
            <span className="text-[10.5px] text-ink-dim truncate max-w-[440px]">
              {paper.authors.slice(0, 6).join(', ')}
              {paper.authors.length > 6 ? ' 等' : ''}
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              void openExternal(paper.url)
            }}
            className="ml-auto text-[10.5px] px-2 py-0.5 rounded bg-surface-2 border border-line text-ink-muted hover:text-primary hover:border-primary/60 transition-colors flex-shrink-0"
            title={paper.url}
          >
            打开原文 ↗
          </button>
        </div>
        {paper.abstract && (
          <p className="text-[11.5px] text-ink-muted leading-5 mt-1.5 line-clamp-3">
            {paper.abstract}
          </p>
        )}
      </div>
    </div>
  )
}

// -- 主组件 ---------------------------------------------------------------------

export default function LitSearchTab() {
  const litSearch = useResearchStore((s) => s.litSearch)
  const litAnalyze = useResearchStore((s) => s.litAnalyze)
  // 只读消费工作台的聚合模型列表（已过滤为 chat 模型）。
  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)
  const loadModels = useWorkbenchStore((s) => s.loadModels)

  const [query, setQuery] = useState('')
  const [source, setSource] = useState('arxiv')
  // DBLP venue 多选；空集 = 全部九个顶会顶刊。
  const [venues, setVenues] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(10)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [papers, setPapers] = useState<LitPaper[]>([])
  const [searched, setSearched] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [showAnalyze, setShowAnalyze] = useState(false)
  const [instruction, setInstruction] = useState(DEFAULT_ANALYZE_INSTRUCTION)
  const [modelKey, setModelKey] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState<LitAnalyzeResult | null>(null)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [analyzeSeconds, setAnalyzeSeconds] = useState(0)
  const [stageIdx, setStageIdx] = useState(0)
  const [doneSeconds, setDoneSeconds] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const [savingKb, setSavingKb] = useState(false)
  const [kbMsg, setKbMsg] = useState<string | null>(null)

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    if (!modelsLoaded) void loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // 卸载时清掉阶段动画定时器
    return () => {
      for (const t of timersRef.current) clearTimeout(t)
      timersRef.current = []
    }
  }, [])

  const chatModels = useMemo(
    () => aggModels.filter((m) => (m.kind ?? 'chat') === 'chat'),
    [aggModels],
  )
  const noChatModel = modelsLoaded && chatModels.length === 0

  useEffect(() => {
    if (!modelKey && chatModels.length > 0) {
      // 默认 gpt-5.5，列表里没有则取第一个。
      const preferred =
        chatModels.find((m) => m.modelId === 'gpt-5.5') ?? chatModels[0]
      setModelKey(preferred.providerId + '|' + preferred.modelId)
    }
  }, [chatModels, modelKey])

  const paperKey = (p: LitPaper) => p.source + ':' + p.id
  const selectedPapers = papers.filter((p) => selected.has(paperKey(p)))

  const doSearch = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchError(null)
    setKbMsg(null)
    try {
      const res = await litSearch(
        q,
        source,
        limit,
        source === 'dblp' ? Array.from(venues) : undefined,
      )
      setPapers(res)
      setSelected(new Set())
      setSearched(true)
    } catch (e) {
      setSearchError('搜索失败：' + String(e))
    } finally {
      setSearching(false)
    }
  }

  const toggle = (p: LitPaper) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = paperKey(p)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const doAnalyze = async () => {
    if (analyzing || selectedPapers.length === 0) return
    const sep = modelKey.indexOf('|')
    if (sep < 0) return
    const providerId = modelKey.slice(0, sep)
    const model = modelKey.slice(sep + 1)
    const n = selectedPapers.length
    setAnalyzing(true)
    setAnalyzeError(null)
    setAnalysis(null)
    setDoneSeconds(null)
    setStageIdx(0)
    setAnalyzeSeconds(0)

    // 真实耗时计时（1s 粒度）
    const startedAt = Date.now()
    const tick = setInterval(() => {
      setAnalyzeSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    // 乐观阶段动画：后端一次性返回，无真实分段事件（见 litsearch.rs lit_analyze），
    // 按篇数估计前两阶段时长；最后阶段保持 running 直到 Promise 返回。
    for (const t of timersRef.current) clearTimeout(t)
    const stage1At = Math.min(25, 4 + 2 * n) * 1000
    const stage2At = stage1At + Math.min(90, 10 + 12 * n) * 1000
    timersRef.current = [
      setTimeout(() => setStageIdx(1), stage1At),
      setTimeout(() => setStageIdx(2), stage2At),
    ]

    try {
      const res = await litAnalyze(
        selectedPapers,
        instruction.trim() || DEFAULT_ANALYZE_INSTRUCTION,
        model,
        providerId,
      )
      setAnalysis(res)
      setStageIdx(ANALYZE_STAGES.length)
      setDoneSeconds(Math.round((Date.now() - startedAt) / 1000))
    } catch (e) {
      setAnalyzeError('分析失败：' + String(e))
    } finally {
      clearInterval(tick)
      for (const t of timersRef.current) clearTimeout(t)
      timersRef.current = []
      setAnalyzing(false)
    }
  }

  /**
   * 勾选文献一键入库：kb.rs 只支持基于真实文件的登记（kb_upload_paper），
   * 且后端没有 PDF 下载命令 —— 因此为每篇生成 .md 元数据条目写入
   * kb_root/lit-inbox/，登记后回填标题/作者/年份/来源/DOI/链接。
   */
  const doSaveToKb = async () => {
    if (savingKb || selectedPapers.length === 0) return
    setSavingKb(true)
    setKbMsg(null)
    try {
      const kb = useKbStore.getState()
      const root = await kb.rootGet()
      if (!root) throw new Error('知识库根目录未设置')
      const { invoke } = await import('@tauri-apps/api/core')
      let ok = 0
      const failed: string[] = []
      for (const p of selectedPapers) {
        try {
          const path = root.replace(/[\/]+$/, '') + '/lit-inbox/' + safeStubName(p) + '.md'
          await invoke('export_text_file', { path, content: paperStubMarkdown(p) })
          const id = await kb.uploadPaper(path, 'index', null)
          const year = parseInt(p.year, 10)
          await kb.updateMetadata(id, {
            title: p.title || null,
            authors: p.authors.length > 0 ? p.authors.join(', ') : null,
            year: Number.isFinite(year) ? year : null,
            venue: p.venue || LIT_SOURCE_LABEL[p.source] || p.source,
            doi: p.doi || null,
            notes: p.url ? '原文链接: ' + p.url : null,
          })
          ok++
        } catch (e) {
          failed.push(p.title + '（' + String(e) + '）')
        }
      }
      setKbMsg(
        '已入库 ' + ok + ' 条（元数据 + 链接条目，未下载 PDF）' +
          (failed.length > 0 ? '；失败 ' + failed.length + ' 条：' + failed[0] : ''),
      )
    } catch (e) {
      setKbMsg('入库失败：' + String(e))
    } finally {
      setSavingKb(false)
    }
  }

  const copyAnalysis = async () => {
    if (!analysis) return
    try {
      await navigator.clipboard.writeText(analysisToMarkdown(analysis))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const toolBtn =
    'text-[11.5px] px-2.5 py-1 rounded-md bg-surface-2 border border-line text-ink hover:bg-elevated transition-colors'
  const selectCls =
    'bg-surface border border-line rounded-lg px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:border-primary transition-colors'

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2.5 border-b border-line flex-shrink-0 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doSearch()
          }}
          placeholder="输入关键词搜索文献（如 homomorphic encryption）"
          className="flex-1 min-w-[240px] bg-surface border border-line rounded-lg px-3 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors"
        />
        <select value={source} onChange={(e) => setSource(e.target.value)} className={selectCls}>
          <option value="arxiv">arXiv</option>
          <option value="eprint">IACR ePrint</option>
          <option value="dblp">DBLP（顶会顶刊）</option>
          <option value="openalex">OpenAlex</option>
        </select>
        <select
          value={String(limit)}
          onChange={(e) => setLimit(Number(e.target.value))}
          className={selectCls}
        >
          <option value="5">5 条</option>
          <option value="10">10 条</option>
          <option value="20">20 条</option>
          <option value="30">30 条</option>
        </select>
        <button
          onClick={() => void doSearch()}
          disabled={searching || !query.trim()}
          className="text-[12px] px-4 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
        >
          {searching ? '搜索中…' : '搜索'}
        </button>
      </div>

      {source === 'dblp' && (
        <div className="px-4 py-2 border-b border-line/60 flex-shrink-0 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-dim mr-1">会议/期刊：</span>
          <button
            onClick={() => setVenues(new Set())}
            className={
              'text-[10.5px] px-2 py-0.5 rounded-md border transition-colors ' +
              (venues.size === 0
                ? 'bg-primary-tint border-primary/60 text-primary font-medium'
                : 'bg-surface-2 border-line text-ink-muted hover:text-ink')
            }
          >
            全部
          </button>
          {DBLP_VENUES.map((v) => (
            <button
              key={v.key}
              onClick={() =>
                setVenues((prev) => {
                  const next = new Set(prev)
                  if (next.has(v.key)) next.delete(v.key)
                  else next.add(v.key)
                  return next
                })
              }
              className={
                'text-[10.5px] px-2 py-0.5 rounded-md border transition-colors ' +
                (venues.has(v.key)
                  ? 'bg-primary-tint border-primary/60 text-primary font-medium'
                  : 'bg-surface-2 border-line text-ink-muted hover:text-ink')
              }
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {searchError && (
        <div className="px-4 py-2 text-[12px] text-failed border-b border-line/60">
          {searchError}
        </div>
      )}
      {kbMsg && (
        <div
          className={
            'px-4 py-2 text-[12px] border-b border-line/60 flex items-center gap-2 ' +
            (kbMsg.startsWith('入库失败') ? 'text-failed' : 'text-done')
          }
        >
          <span className="flex-1">{kbMsg}</span>
          <button className="text-ink-dim hover:text-ink" onClick={() => setKbMsg(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
        {searching ? (
          <div className="text-[12px] text-ink-dim">正在检索文献…</div>
        ) : papers.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-16">
            <Mascot mood="idle" size={64} className="mb-3" />
            <p className="text-ink-muted text-sm">
              {searched ? '没有找到相关文献' : '输入关键词开始搜索'}
            </p>
            <p className="text-ink-dim text-xs mt-1">
              {searched
                ? '换个关键词或切换数据源试试。'
                : '支持 arXiv、IACR ePrint、DBLP（CRYPTO/S&P 等九大密码学与安全顶会顶刊）与 OpenAlex，搜到后勾选文献即可做 AI 分析或一键入库。'}
            </p>
          </div>
        ) : (
          papers.map((p) => (
            <PaperCard
              key={paperKey(p)}
              paper={p}
              checked={selected.has(paperKey(p))}
              onToggle={() => toggle(p)}
            />
          ))
        )}
      </div>

      {papers.length > 0 && (
        <div className="px-4 py-2.5 border-t border-line flex-shrink-0 flex flex-wrap items-center gap-2 bg-surface">
          <button onClick={() => setSelected(new Set(papers.map(paperKey)))} className={toolBtn}>
            全选
          </button>
          <button onClick={() => setSelected(new Set())} className={toolBtn}>
            清空
          </button>
          <span className="text-[11.5px] text-ink-dim">
            已选 {selectedPapers.length} / {papers.length} 篇
          </span>
          <div className="flex-1" />
          <button
            onClick={() => useScienceStore.getState().enterAnalysisFromLit(selectedPapers)}
            disabled={selectedPapers.length === 0}
            title={
              selectedPapers.length === 0
                ? '请先勾选文献'
                : '把勾选文献送入「文献分析」工作台(原文预览 / 划线高亮 / 提问 / 报告)'
            }
            className={toolBtn + ' disabled:opacity-40'}
          >
            进入文献分析（{selectedPapers.length}）
          </button>
          <button
            onClick={() => void doSaveToKb()}
            disabled={savingKb || selectedPapers.length === 0}
            title={
              selectedPapers.length === 0
                ? '请先勾选文献'
                : '将勾选文献的元数据 + 链接保存为知识库条目（不下载 PDF）'
            }
            className={toolBtn + ' disabled:opacity-40'}
          >
            {savingKb ? '入库中…' : '存入知识库（' + selectedPapers.length + '）'}
          </button>
          {noChatModel ? (
            <span className="text-[11px] text-ink-dim">
              暂无可用聊天模型 — 请先在「设置」添加 OpenAI 兼容服务商
            </span>
          ) : (
            <button
              onClick={() => setShowAnalyze(true)}
              disabled={selectedPapers.length === 0}
              title={selectedPapers.length === 0 ? '请先勾选文献' : undefined}
              className="text-[12px] px-4 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              分析选中（{selectedPapers.length}）
            </button>
          )}
        </div>
      )}

      {showAnalyze && (
        <div
          className="fixed inset-0 z-50 flex bg-black/40"
          onClick={() => {
            if (!analyzing) setShowAnalyze(false)
          }}
        >
          <div
            className="ml-auto h-full w-full max-w-2xl bg-bg border-l border-line flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
              <span className="text-[13.5px] text-ink font-semibold">
                文献分析 · 已选 {selectedPapers.length} 篇
              </span>
              {doneSeconds != null && (
                <span className="text-[11px] text-ink-dim font-mono">
                  实际耗时 {doneSeconds}s
                </span>
              )}
              <div className="flex-1" />
              {analysis && (
                <>
                  <button onClick={() => void copyAnalysis()} className={toolBtn}>
                    {copied ? '已复制' : '复制'}
                  </button>
                  <button
                    onClick={() =>
                      void saveExport('文献分析', 'md', analysisToMarkdown(analysis))
                    }
                    className={toolBtn}
                  >
                    导出 .md
                  </button>
                </>
              )}
              <button
                onClick={() => setShowAnalyze(false)}
                disabled={analyzing}
                className="text-ink-dim hover:text-ink text-lg leading-none px-1 disabled:opacity-40"
                title="关闭"
              >
                ✕
              </button>
            </div>
            <div className="px-4 py-3 border-b border-line/60 flex-shrink-0 space-y-2">
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
                placeholder={DEFAULT_ANALYZE_INSTRUCTION}
                className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors resize-none"
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-dim flex-shrink-0">分析模型</span>
                <select
                  value={modelKey}
                  onChange={(e) => setModelKey(e.target.value)}
                  disabled={analyzing}
                  className={selectCls + ' max-w-[320px]'}
                >
                  {chatModels.map((m) => (
                    <option
                      key={m.providerId + '|' + m.modelId}
                      value={m.providerId + '|' + m.modelId}
                    >
                      {m.providerLabel} · {m.modelId}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void doAnalyze()}
                  disabled={analyzing || selectedPapers.length === 0 || !modelKey}
                  className="ml-auto text-[12px] px-4 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
                >
                  {analyzing ? '分析中…' : '开始分析'}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              {analyzing ? (
                <AnalyzeProgress
                  stageIdx={stageIdx}
                  elapsed={analyzeSeconds}
                  paperCount={selectedPapers.length}
                />
              ) : analyzeError ? (
                <div className="text-[12px] text-failed">{analyzeError}</div>
              ) : analysis ? (
                <div>
                  <LitMarkdown text={analysis.analysis} />
                  <FigureAppendix papers={analysis.papers} />
                </div>
              ) : (
                <div className="text-[12px] text-ink-dim">
                  将自动抓取勾选文献的开放版原文：arXiv 走 ar5iv HTML 全文；DBLP/OpenAlex
                  论文自动匹配 arXiv 或 IACR ePrint 开放版（找不到开放版则仅用元数据并注明，
                  不抓取付费墙正文）；ePrint 用其公开摘要页。随后按固定模板逐篇生成详细报告：
                  摘要 / 背景知识 / Idea Overview / 是否开源 / 方法要点 / 实现与效果 /
                  重要图表；多篇时附横向对比。
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
