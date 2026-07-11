import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Editor from '@monaco-editor/react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MONACO_THEME } from '../lib/monacoSetup'
import { Mascot, StatusDot } from '../components/ui'
import type { StatusKind } from '../components/ui/StatusDot'
import { useWorkbenchStore } from '../stores/workbenchStore'
import { useStudioStore } from '../stores/studioStore'
import ProviderGuideCard from '../components/ProviderGuideCard'
import { saveExport } from '../lib/exportChat'
import {
  useResearchStore,
  type MdMeta,
  type PipelineInfo,
  type DashboardRun,
  type RunArtifact,
  type ResearchTab,
  type LitPaper,
  type LitAnalyzeResult,
  type LitPaperExtras,
  type LitFigure,
} from '../stores/researchStore'

const NL = String.fromCharCode(10)

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function convertPath(p: string): Promise<string> {
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(p)
  } catch {
    return p
  }
}

function fmtDate(s: string): string {
  if (!s) return ''
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}

function runStatusKind(s: string): StatusKind {
  if (s === 'completed' || s === 'success' || s === 'done') return 'done'
  if (s === 'running' || s === 'active' || s === 'in_progress') return 'running'
  if (s === 'failed' || s === 'error') return 'failed'
  return 'idle'
}

const RUN_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  success: '成功',
  running: '运行中',
  active: '进行中',
  in_progress: '进行中',
  failed: '失败',
  error: '出错',
  draft_complete: '草稿完成',
}
function runStatusLabel(s: string): string {
  return RUN_STATUS_LABEL[s] ?? s
}

const CARD =
  'bg-surface border border-line rounded-card shadow-card transition-all duration-150'
const CARD_HOVER =
  CARD + ' hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop'

function MdEditorOverlay({
  meta,
  initial,
  onClose,
  onSave,
  onUse,
  useLabel,
}: {
  meta: MdMeta
  initial: string
  onClose: () => void
  onSave: (content: string) => Promise<void>
  onUse: () => void
  useLabel: string
}) {
  const [content, setContent] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const dirty = content !== initial

  const doSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      await onSave(content)
      setSaveMsg('已保存')
    } catch (e) {
      setSaveMsg('保存失败：' + String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40" onClick={onClose}>
      <div
        className="ml-auto h-full w-full max-w-3xl bg-bg border-l border-line flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
          <div className="min-w-0">
            <div className="text-[14px] text-ink font-semibold truncate">
              {meta.title}
            </div>
            <div className="text-[10px] text-ink-dim font-mono truncate" title={meta.path}>
              {meta.path}
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={onUse}
            className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors flex-shrink-0"
            title="打开工作台,用该定义开一轮"
          >
            {useLabel}
          </button>
          <button
            onClick={doSave}
            disabled={!dirty || saving}
            className="text-[11px] px-2.5 py-1 rounded-md bg-surface-2 border border-line text-ink hover:bg-elevated disabled:opacity-40 transition-colors flex-shrink-0"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            onClick={onClose}
            className="text-ink-dim hover:text-ink text-lg leading-none px-1 flex-shrink-0"
            title="关闭"
          >
            ✕
          </button>
        </div>
        {saveMsg && (
          <div className="px-4 py-1.5 text-[11px] text-ink-muted border-b border-line/60">
            {saveMsg}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <Editor
            theme={MONACO_THEME}
            language="markdown"
            value={content}
            onChange={(v) => setContent(v ?? '')}
            options={{
              fontSize: 12.5,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 8, bottom: 8 },
              tabSize: 2,
              automaticLayout: true,
            }}
            loading={<div className="p-4 text-[12px] text-ink-dim">编辑器加载中…</div>}
          />
        </div>
      </div>
    </div>
  )
}

function MdCard({ meta, onOpen }: { meta: MdMeta; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={CARD_HOVER + ' p-4 flex flex-col text-left w-full'}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[13.5px] text-ink font-semibold truncate">
          {meta.title}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-tint text-primary font-medium">
          {meta.category}
        </span>
        <span className="text-[10px] text-ink-dim font-mono truncate">{meta.name}</span>
      </div>
      <p className="text-[12px] text-ink-muted leading-5 line-clamp-3 flex-1">
        {meta.description || '（无描述）'}
      </p>
    </button>
  )
}

function PipelineCard({
  pipeline,
  onRun,
}: {
  pipeline: PipelineInfo
  onRun: (input: string) => void
}) {
  const [input, setInput] = useState('')
  return (
    <div className={CARD + ' p-4 flex flex-col'}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[13.5px] text-ink font-semibold truncate">
          {pipeline.name}
        </span>
        <span
          className={
            'ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ' +
            (pipeline.source === 'skill'
              ? 'bg-[#3fb9501f] text-done'
              : 'bg-primary-tint text-primary')
          }
        >
          {pipeline.source === 'skill' ? 'skill' : 'agent'}
        </span>
      </div>
      <p className="text-[12px] text-ink-muted leading-5 line-clamp-2 mb-2">
        {pipeline.description || '（无描述）'}
      </p>
      {pipeline.steps.length > 0 && (
        <div className="text-[11px] text-ink-dim font-mono leading-5 mb-2 line-clamp-2">
          {pipeline.steps.join(' → ')}
        </div>
      )}
      <div className="mt-auto flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="主题 / 输入(可选)"
          className="flex-1 min-w-0 bg-surface border border-line rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors"
        />
        <button
          onClick={() => onRun(input)}
          className="text-[11px] px-3 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors flex-shrink-0"
          title="进工作台运行该流水线"
        >
          运行
        </button>
      </div>
    </div>
  )
}

function ArtifactButtons({ artifacts }: { artifacts: RunArtifact[] }) {
  const readRunOutput = useResearchStore((s) => s.readRunOutput)
  const [text, setText] = useState<{ kind: string; body: string } | null>(null)

  const open = async (a: RunArtifact) => {
    if (a.kind === 'pdf') {
      const url = await convertPath(a.path)
      window.open(url, '_blank')
      return
    }
    if (a.kind === 'html') {
      try {
        const body = await readRunOutput(a.path)
        const blob = new Blob([body], { type: 'text/html' })
        window.open(URL.createObjectURL(blob), '_blank')
      } catch {
        const url = await convertPath(a.path)
        window.open(url, '_blank')
      }
      return
    }
    try {
      const body = await readRunOutput(a.path)
      setText({ kind: a.kind, body })
    } catch (e) {
      setText({ kind: a.kind, body: '读取失败：' + String(e) })
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {artifacts.length === 0 && (
          <span className="text-[10px] text-ink-dim">（无产物）</span>
        )}
        {artifacts.map((a) => (
          <button
            key={a.path}
            onClick={() => open(a)}
            className="text-[10.5px] px-2 py-0.5 rounded bg-surface-2 border border-line text-ink-muted hover:text-primary hover:border-primary/60 transition-colors font-mono"
            title={a.path}
          >
            {a.kind.toUpperCase()}
          </button>
        ))}
      </div>
      {text && (
        <div
          className="fixed inset-0 z-50 flex bg-black/40"
          onClick={() => setText(null)}
        >
          <div
            className="ml-auto h-full w-full max-w-2xl bg-bg border-l border-line flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
              <span className="text-[13px] text-ink font-semibold">
                产物预览 · {text.kind.toUpperCase()}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setText(null)}
                className="text-ink-dim hover:text-ink text-lg leading-none px-1"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-[11.5px] text-ink-muted font-mono whitespace-pre-wrap">
              {text.body}
            </pre>
          </div>
        </div>
      )}
    </>
  )
}

function RunCard({ run }: { run: DashboardRun }) {
  return (
    <div className={CARD + ' p-4 flex flex-col'}>
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot status={runStatusKind(run.status)} pulse={run.status === 'running'} />
        <span className="text-[13px] text-ink font-semibold truncate">
          {run.title}
        </span>
        <span className="ml-auto text-[10px] text-ink-dim flex-shrink-0">
          {fmtDate(run.updated_at || run.created_at)}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-tint text-primary font-medium">
          {runStatusLabel(run.status)}
        </span>
        {run.current_stage && (
          <span className="text-[10px] text-ink-dim font-mono">
            阶段: {run.current_stage}
          </span>
        )}
        <span className="ml-auto text-[10px] text-ink-dim font-mono">{run.id}</span>
      </div>
      {run.stages.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2.5">
          {run.stages.map((st, i) => (
            <span
              key={i}
              className={
                'text-[9.5px] px-1.5 py-0.5 rounded font-medium ' +
                (st.status === 'completed'
                  ? 'bg-[#3fb9501f] text-done'
                  : st.status === 'running'
                    ? 'bg-primary-tint text-primary'
                    : 'bg-surface-2 text-ink-dim')
              }
              title={st.status + ' · ' + st.progress + '%'}
            >
              {st.title}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto pt-1 border-t border-line/60">
        <div className="text-[10px] text-ink-dim mb-1">产物</div>
        <ArtifactButtons artifacts={run.artifacts} />
      </div>
    </div>
  )
}

function DashboardTab() {
  const { dashboard, dashboardLoading, loadDashboard } = useResearchStore()

  useEffect(() => {
    if (!dashboard) void loadDashboard()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (dashboardLoading && !dashboard) {
    return <div className="p-4 text-[12px] text-ink-dim">加载中…</div>
  }
  if (!dashboard) {
    return <div className="p-4 text-[12px] text-ink-dim">暂无仪表盘数据</div>
  }

  const activeSkills = dashboard.skills.filter((s) => s.runs > 0)

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div className="flex flex-wrap gap-3">
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">知识库论文</div>
          <div className="text-[20px] font-bold text-ink">{dashboard.kb_total_papers}</div>
        </div>
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">知识库大小</div>
          <div className="text-[20px] font-bold text-ink">
            {dashboard.kb_total_size_mb.toFixed(1)} MB
          </div>
        </div>
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">运行记录</div>
          <div className="text-[20px] font-bold text-ink">{dashboard.runs.length}</div>
        </div>
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">最近扫描</div>
          <div className="text-[12px] font-medium text-ink mt-1.5">
            {dashboard.kb_last_scan ? fmtDate(dashboard.kb_last_scan) : '—'}
          </div>
        </div>
      </div>

      <section>
        <h2 className="text-[13px] font-semibold text-ink mb-2">工作流运行</h2>
        {dashboard.runs.length === 0 ? (
          <div className="text-[12px] text-ink-dim">还没有运行记录</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {dashboard.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>

      {activeSkills.length > 0 && (
        <section>
          <h2 className="text-[13px] font-semibold text-ink mb-2">技能运行统计</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {activeSkills.map((sk) => (
              <div
                key={sk.name}
                className={CARD + ' px-3 py-2 flex items-center gap-2'}
              >
                <StatusDot status={sk.status === 'running' ? 'running' : 'idle'} />
                <span className="text-[12px] text-ink font-mono truncate">{sk.name}</span>
                <span className="ml-auto text-[11px] text-ink-dim">
                  {sk.successes}/{sk.runs} 次
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-[13px] font-semibold text-ink mb-2">近期执行日志</h2>
        {dashboard.logs.length === 0 ? (
          <div className="text-[12px] text-ink-dim">暂无日志</div>
        ) : (
          <div className="space-y-1.5">
            {dashboard.logs.map((log, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-[11.5px] px-3 py-1.5 rounded-lg bg-surface border border-line"
              >
                <StatusDot status={log.status === 'success' ? 'done' : 'idle'} />
                <span className="text-ink font-mono">{log.skill}</span>
                <span className="text-ink-muted truncate">{log.summary}</span>
                <span className="ml-auto text-ink-dim flex-shrink-0">
                  {fmtDate(log.finished)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// -- 文献搜索（v0.8）-----------------------------------------------------------

const DEFAULT_ANALYZE_INSTRUCTION =
  '按标准模板逐篇详细分析这些文献，并给出横向对比与研究缺口'
const LIT_REMARK_PLUGINS = [remarkGfm]

/** 在系统浏览器打开链接（永不在 webview 内跳转）。 */
async function openExternal(url: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url })
  } catch (e) {
    console.warn('[Research] openExternal failed:', e)
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
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#3fb9501f] text-done font-medium flex-shrink-0">
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

function LitSearchTab() {
  const litSearch = useResearchStore((s) => s.litSearch)
  const litAnalyze = useResearchStore((s) => s.litAnalyze)
  const aggModels = useStudioStore((s) => s.aggModels)
  const modelsLoaded = useStudioStore((s) => s.modelsLoaded)
  const loadModels = useStudioStore((s) => s.loadModels)

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
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!modelsLoaded) void loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const chatModels = useMemo(
    () => aggModels.filter((m) => m.kind === 'chat'),
    [aggModels],
  )
  const noChatModel = modelsLoaded && chatModels.length === 0

  useEffect(() => {
    if (!modelKey && chatModels.length > 0) {
      setModelKey(chatModels[0].providerId + '|' + chatModels[0].modelId)
    }
  }, [chatModels, modelKey])

  const paperKey = (p: LitPaper) => p.source + ':' + p.id
  const selectedPapers = papers.filter((p) => selected.has(paperKey(p)))

  const doSearch = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchError(null)
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
    setAnalyzing(true)
    setAnalyzeError(null)
    setAnalysis(null)
    try {
      const res = await litAnalyze(
        selectedPapers,
        instruction.trim() || DEFAULT_ANALYZE_INSTRUCTION,
        model,
        providerId,
      )
      setAnalysis(res)
    } catch (e) {
      setAnalyzeError('分析失败：' + String(e))
    } finally {
      setAnalyzing(false)
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
                : '支持 arXiv、IACR ePrint、DBLP（CRYPTO/S&P 等九大密码学与安全顶会顶刊）与 OpenAlex，搜到后勾选文献即可做 AI 分析。'}
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
          {noChatModel ? (
            <div className="max-w-xs">
              <ProviderGuideCard
                compact
                title="暂无可用聊天模型"
                hint="添加一个 OpenAI 兼容服务商后，即可对勾选的文献做 AI 分析。"
              />
            </div>
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
                <select
                  value={modelKey}
                  onChange={(e) => setModelKey(e.target.value)}
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
                <div className="text-[12px] text-ink-dim space-y-1.5">
                  <div>
                    正在抓取论文原文（ar5iv 全文 / 重要图表 / 开源代码链接）并生成逐篇结构化分析…
                  </div>
                  <div>全文抓取 + 详细报告耗时较长，勾选越多越慢，请耐心等待。</div>
                </div>
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

export default function Research() {
  const navigate = useNavigate()
  const store = useResearchStore()
  const requestReuse = useWorkbenchStore((s) => s.requestReuse)

  const [tab, setTab] = useState<ResearchTab>('agents')
  const [editing, setEditing] = useState<{
    meta: MdMeta
    initial: string
    kind: 'agent' | 'skill'
  } | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void store.loadRoots()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'agents' && !store.agentsLoaded) void store.loadAgents()
    if (tab === 'skills' && !store.skillsLoaded) void store.loadSkills()
    if (tab === 'pipelines' && !store.pipelinesLoaded) void store.loadPipelines()
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const openAgent = async (meta: MdMeta) => {
    try {
      const initial = await store.readAgent(meta.path)
      setEditing({ meta, initial, kind: 'agent' })
    } catch (e) {
      useResearchStore.setState({ error: '读取失败：' + String(e) })
    }
  }
  const openSkill = async (meta: MdMeta) => {
    try {
      const initial = await store.readSkill(meta.path)
      setEditing({ meta, initial, kind: 'skill' })
    } catch (e) {
      useResearchStore.setState({ error: '读取失败：' + String(e) })
    }
  }

  const useInWorkbench = (meta: MdMeta) => {
    const cwd =
      editing?.kind === 'skill'
        ? store.roots?.skills_root ?? ''
        : store.roots?.agents_root ?? ''
    const kindLabel = editing?.kind === 'skill' ? 'skill' : 'agent'
    const prompt =
      '请以下面这个科研 ' +
      kindLabel +
      '「' +
      meta.title +
      '」(' +
      meta.name +
      ') 的定义来完成任务。定义文件位于:' +
      NL +
      meta.path +
      NL +
      NL +
      meta.description
    requestReuse({ cwd, model: '', prompt })
    setEditing(null)
    navigate('/workbench')
  }

  const runPipeline = async (pl: PipelineInfo, input: string) => {
    try {
      const launch = await store.runPipeline(pl.id, input)
      requestReuse({ cwd: launch.cwd, model: '', prompt: launch.prompt })
      navigate('/workbench')
    } catch (e) {
      useResearchStore.setState({ error: '运行失败：' + String(e) })
    }
  }

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return store.agents
    return store.agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    )
  }, [store.agents, query])

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return store.skills
    return store.skills.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    )
  }, [store.skills, query])

  const skillsByCategory = useMemo(() => {
    const map = new Map<string, MdMeta[]>()
    for (const sk of filteredSkills) {
      const arr = map.get(sk.category) ?? []
      arr.push(sk)
      map.set(sk.category, arr)
    }
    return Array.from(map.entries())
  }, [filteredSkills])

  const TabButton = ({ id, label }: { id: ResearchTab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={
        'px-3 py-1.5 text-[13px] rounded-lg transition-colors ' +
        (tab === id ? 'bg-primary-tint text-primary font-semibold' : 'text-ink-dim hover:text-ink')
      }
    >
      {label}
    </button>
  )

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold text-gradient mr-2">科研</h1>
          <TabButton id="agents" label="Agent 库" />
          <TabButton id="skills" label="Skill 库" />
          <TabButton id="pipelines" label="流水线" />
          <TabButton id="dashboard" label="仪表盘" />
          <TabButton id="lit" label="文献搜索" />
        </div>
        <p className="text-[11px] text-ink-dim mt-1">
          集成本地 agent管理 / skills管理:浏览编辑 agent·skill 定义、运行流水线、查看运行仪表盘、搜索并分析文献。
        </p>
      </header>

      {store.error && (
        <div className="px-4 py-2 text-[12px] text-failed border-b border-line/60">
          {store.error}
        </div>
      )}

      {(tab === 'agents' || tab === 'skills') && (
        <div className="px-4 py-2.5 border-b border-line flex-shrink-0">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 分类 / 描述"
            className="w-full max-w-md bg-surface border border-line rounded-lg px-3 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors"
          />
        </div>
      )}

      {tab === 'agents' && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {store.agentsLoading && store.agents.length === 0 ? (
            <div className="text-[12px] text-ink-dim">扫描中…</div>
          ) : filteredAgents.length === 0 ? (
            <EmptyState label="没有找到 agent" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredAgents.map((a) => (
                <MdCard key={a.path} meta={a} onOpen={() => void openAgent(a)} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'skills' && (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {store.skillsLoading && store.skills.length === 0 ? (
            <div className="text-[12px] text-ink-dim">扫描中…</div>
          ) : filteredSkills.length === 0 ? (
            <EmptyState label="没有找到 skill" />
          ) : (
            skillsByCategory.map(([cat, items]) => (
              <section key={cat}>
                <h2 className="text-[12.5px] font-semibold text-ink-muted mb-2 uppercase tracking-wide">
                  {cat}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {items.map((sk) => (
                    <MdCard key={sk.path} meta={sk} onOpen={() => void openSkill(sk)} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {tab === 'pipelines' && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {store.pipelinesLoading && store.pipelines.length === 0 ? (
            <div className="text-[12px] text-ink-dim">加载中…</div>
          ) : store.pipelines.length === 0 ? (
            <EmptyState label="没有可运行的流水线" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {store.pipelines.map((p) => (
                <PipelineCard
                  key={p.source + ':' + p.id}
                  pipeline={p}
                  onRun={(input) => void runPipeline(p, input)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'dashboard' && <DashboardTab />}

      {tab === 'lit' && <LitSearchTab />}

      {editing && (
        <MdEditorOverlay
          meta={editing.meta}
          initial={editing.initial}
          useLabel="在工作台使用"
          onClose={() => setEditing(null)}
          onUse={() => useInWorkbench(editing.meta)}
          onSave={async (content) => {
            if (editing.kind === 'agent') await store.writeAgent(editing.meta.path, content)
            else await store.writeSkill(editing.meta.path, content)
          }}
        />
      )}
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-20">
      <Mascot mood="idle" size={72} className="mb-4" />
      <p className="text-ink-muted text-sm">{label}</p>
      <p className="text-ink-dim text-xs mt-1">
        {isTauri
          ? '确认源目录存在,或在后端设置里调整根路径。'
          : '在 Tauri 应用内可用。'}
      </p>
    </div>
  )
}
