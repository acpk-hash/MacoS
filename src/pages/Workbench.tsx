import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import {
  useWorkbenchStore,
  type WorkbenchEntry,
  type TouchedFile,
  type WorkbenchStats,
} from '../stores/workbenchStore'
import ModelPicker from '../components/ModelPicker'
import Composer from '../components/Composer'
import type { Attachment } from '../stores/studioStore'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

// ── Markdown (stable module-scope plugin refs; never rebuilt per token) ────────

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [
  rehypeHighlight,
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
] as never

const mdComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-gray-800 bg-[#0d1117] p-2.5 text-[12.5px] leading-relaxed">
      {children}
    </pre>
  ),
  code(props) {
    const { className, children } = props
    const isBlock = /language-/.test(className || '')
    if (!isBlock) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-gray-800 text-[0.85em] font-mono text-emerald-200">
          {children}
        </code>
      )
    }
    return <code className={className}>{children}</code>
  },
  p: ({ children }) => <p className="my-1.5 leading-6">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  h1: ({ children }) => <h1 className="text-lg font-semibold mt-3 mb-1.5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} className="text-emerald-400 underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-700 pl-3 my-1.5 text-gray-400">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-gray-700 px-2 py-1 bg-gray-900 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-gray-800 px-2 py-1">{children}</td>,
}

const MarkdownLite = React.memo(function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="text-[14px] text-gray-200 break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

function Blink() {
  return (
    <span className="inline-block w-[7px] h-[14px] ml-0.5 -mb-0.5 bg-emerald-400/80 animate-pulse rounded-[1px] align-middle" />
  )
}

function baseName(p: string): string {
  const parts = p.split(/[\/]/)
  return parts[parts.length - 1] || p
}

// ── Tool cards ─────────────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="overflow-x-auto p-2.5 text-[12px] leading-relaxed font-mono">
      {lines.map((l, i) => {
        const add = l.startsWith('+')
        const del = l.startsWith('-')
        return (
          <div
            key={i}
            className={[
              'whitespace-pre-wrap break-words px-1 -mx-1',
              add ? 'bg-emerald-950/40 text-emerald-300' : '',
              del ? 'bg-red-950/40 text-red-300' : '',
              !add && !del ? 'text-gray-400' : '',
            ].join(' ')}
          >
            {l || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function ToolShell({
  icon,
  title,
  badge,
  children,
  domId,
}: {
  icon: string
  title: React.ReactNode
  badge?: React.ReactNode
  children?: React.ReactNode
  domId?: string
}) {
  return (
    <div
      id={domId}
      className="my-2 rounded-md border border-gray-800 bg-gray-900/60 overflow-hidden scroll-mt-4"
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-900/80 border-b border-gray-800">
        <span className="text-[13px]" aria-hidden="true">
          {icon}
        </span>
        <span className="text-[12.5px] text-gray-300 font-mono truncate flex-1">{title}</span>
        {badge}
      </div>
      {children}
    </div>
  )
}

const BashCard = React.memo(function BashCard({
  cmd,
  output,
  exitCode,
}: {
  cmd: string
  output: string
  exitCode: number | null
}) {
  const ok = exitCode == null || exitCode === 0
  return (
    <ToolShell
      icon="$"
      title={<span className="text-gray-200">{cmd}</span>}
      badge={
        exitCode != null ? (
          <span
            className={[
              'text-[10px] px-1.5 py-0.5 rounded font-mono',
              ok ? 'bg-emerald-900/60 text-emerald-300' : 'bg-red-900/60 text-red-300',
            ].join(' ')}
          >
            exit {exitCode}
          </span>
        ) : null
      }
    >
      {output.trim() && (
        <pre className="overflow-x-auto p-2.5 text-[12px] leading-relaxed font-mono text-gray-300 whitespace-pre-wrap break-words max-h-72">
          {output}
        </pre>
      )}
    </ToolShell>
  )
})

const EditCard = React.memo(function EditCard({
  path,
  diff,
  domId,
}: {
  path: string
  diff: string
  domId: string
}) {
  return (
    <ToolShell
      icon="✎"
      domId={domId}
      title={<span className="text-emerald-300" title={path}>{path}</span>}
      badge={<span className="text-[10px] text-gray-500">编辑</span>}
    >
      {diff.trim() ? (
        <DiffView diff={diff} />
      ) : (
        <div className="px-2.5 py-2 text-[12px] text-gray-500">已修改文件</div>
      )}
    </ToolShell>
  )
})

const WriteCard = React.memo(function WriteCard({
  path,
  domId,
}: {
  path: string
  domId: string
}) {
  return (
    <ToolShell
      icon="+"
      domId={domId}
      title={<span className="text-emerald-300" title={path}>{path}</span>}
      badge={<span className="text-[10px] text-emerald-400">已写入</span>}
    />
  )
})

const ResultCard = React.memo(function ResultCard({
  tool,
  output,
  isError,
}: {
  tool: string
  output: string
  isError: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <ToolShell
      icon="⚙"
      title={<span className="text-gray-300">{tool}</span>}
      badge={
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] text-gray-500 hover:text-gray-300"
        >
          {open ? '收起' : '详情'}
        </button>
      }
    >
      {open && output.trim() && (
        <pre
          className={[
            'overflow-x-auto p-2.5 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-72',
            isError ? 'text-red-300' : 'text-gray-400',
          ].join(' ')}
        >
          {output}
        </pre>
      )}
    </ToolShell>
  )
})

const ThinkingBlock = React.memo(function ThinkingBlock({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-400"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>思考{streaming ? '中…' : '过程'}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 border-gray-800 text-[12.5px] text-gray-500 whitespace-pre-wrap break-words leading-6">
          {text}
          {streaming && <Blink />}
        </div>
      )}
    </div>
  )
})

// ── Entry dispatcher ───────────────────────────────────────────────────────────

const EntryItem = React.memo(function EntryItem({ entry }: { entry: WorkbenchEntry }) {
  const domId = `wb-entry-${entry.id}`
  switch (entry.kind) {
    case 'user':
      return (
        <div id={domId} className="flex items-start gap-2 mt-4 scroll-mt-4">
          <span className="text-emerald-400 font-mono text-[14px] select-none mt-0.5">›</span>
          <div className="text-[14px] text-gray-100 whitespace-pre-wrap break-words flex-1">
            {entry.steer && (
              <span className="mr-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 align-middle">
                插话
              </span>
            )}
            {entry.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div id={domId} className="scroll-mt-4">
          <MarkdownLite text={entry.text} />
          {entry.streaming && <Blink />}
        </div>
      )
    case 'thinking':
      return (
        <div id={domId} className="scroll-mt-4">
          <ThinkingBlock text={entry.text} streaming={entry.streaming} />
        </div>
      )
    case 'tool_bash':
      return (
        <div id={domId} className="scroll-mt-4">
          <BashCard cmd={entry.cmd} output={entry.output} exitCode={entry.exitCode} />
        </div>
      )
    case 'tool_edit':
      return <EditCard path={entry.path} diff={entry.diff} domId={domId} />
    case 'tool_write':
      return <WriteCard path={entry.path} domId={domId} />
    case 'tool_result':
      return (
        <div id={domId} className="scroll-mt-4">
          <ResultCard tool={entry.tool} output={entry.output} isError={entry.isError} />
        </div>
      )
    case 'error':
      return (
        <div
          id={domId}
          className="my-2 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-[13px] text-red-300 break-words scroll-mt-4"
        >
          {entry.text}
        </div>
      )
    default:
      return null
  }
})

// ── Token badge ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function contextPct(t: WorkbenchStats): number {
  if (t.context_window > 0) {
    return Math.min(100, (t.context_tokens / t.context_window) * 100)
  }
  // context_percent may already be a percentage or a 0-1 fraction.
  return t.context_percent > 1 ? t.context_percent : t.context_percent * 100
}

function Ring({ pct }: { pct: number }) {
  const r = 8
  const c = 2 * Math.PI * r
  const off = c * (1 - Math.max(0, Math.min(1, pct / 100)))
  const color = pct > 85 ? '#f87171' : pct > 60 ? '#fbbf24' : '#34d399'
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" className="-rotate-90">
      <circle cx="11" cy="11" r={r} fill="none" stroke="#374151" strokeWidth="3" />
      <circle
        cx="11"
        cy="11"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={c}
        strokeDashoffset={off}
        strokeLinecap="round"
      />
    </svg>
  )
}

function TokenBadge({ tokens }: { tokens: WorkbenchStats }) {
  const [hover, setHover] = useState(false)
  const pct = contextPct(tokens)
  return (
    <div
      className="relative flex-shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-[11px] text-gray-300 font-mono cursor-default">
        <span className="text-gray-500">Σ</span>
        <span>{fmt(tokens.total)}</span>
      </div>
      {hover && (
        <div className="absolute right-0 top-9 z-40 w-56 p-3 rounded-lg bg-gray-900 border border-gray-700 shadow-xl text-[11px] text-gray-300 font-mono">
          <div className="flex items-center gap-3 mb-2">
            <Ring pct={pct} />
            <div>
              <div className="text-gray-400">上下文占用</div>
              <div className="text-gray-200">
                {pct.toFixed(1)}%
                {tokens.context_window > 0 && (
                  <span className="text-gray-500">
                    {' '}
                    ({fmt(tokens.context_tokens)}/{fmt(tokens.context_window)})
                  </span>
                )}
              </div>
            </div>
          </div>
          <Row k="输入" v={fmt(tokens.input)} />
          <Row k="输出" v={fmt(tokens.output)} />
          <Row k="缓存读" v={fmt(tokens.cache_read)} />
          <Row k="缓存写" v={fmt(tokens.cache_write)} />
          <Row k="合计" v={fmt(tokens.total)} />
          {tokens.cost > 0 && <Row k="费用" v={`$${tokens.cost.toFixed(4)}`} />}
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-gray-500">{k}</span>
      <span>{v}</span>
    </div>
  )
}

// ── File tree (files touched this session) ─────────────────────────────────────

function FileTree({
  files,
  onPick,
}: {
  files: TouchedFile[]
  onPick: (entryId: string) => void
}) {
  return (
    <div className="w-56 flex-shrink-0 border-r border-gray-800 bg-gray-900/40 flex flex-col h-full">
      <div className="px-3 py-2.5 text-[11px] text-gray-500 border-b border-gray-800 select-none">
        本次改动的文件 {files.length > 0 && `(${files.length})`}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <p className="text-gray-600 text-[11px] text-center mt-6 px-3 leading-5 select-none">
            AI 编辑或写入的文件会出现在这里
          </p>
        ) : (
          files.map((f) => (
            <button
              key={f.path}
              onClick={() => onPick(f.entryId)}
              title={f.path}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-800/60 transition-colors group"
            >
              <span
                className={[
                  'text-[11px] flex-shrink-0',
                  f.kind === 'write' ? 'text-emerald-400' : 'text-amber-400',
                ].join(' ')}
              >
                {f.kind === 'write' ? '+' : '✎'}
              </span>
              <span className="text-[12px] text-gray-300 truncate group-hover:text-gray-100">
                {baseName(f.path)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ── Progress bar (Claude-Code style) ───────────────────────────────────────────

function ProgressBar({
  action,
  startedAt,
  total,
  onStop,
}: {
  action: string
  startedAt: number | null
  total: number
  onStop: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])
  const secs = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-800 bg-gray-900/80 flex-shrink-0">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
      <span className="text-[12.5px] text-gray-300 truncate flex-1 font-mono">
        {action || '工作中…'}
      </span>
      <span className="text-[11px] text-gray-500 font-mono flex-shrink-0">
        {secs}s · Σ{fmt(total)}
      </span>
      <button
        onClick={onStop}
        className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md bg-gray-800 hover:bg-red-900/60 border border-gray-700 hover:border-red-800 text-[11px] text-gray-300 hover:text-red-300 transition-colors"
        title="停止当前任务"
      >
        <span className="w-2.5 h-2.5 bg-current rounded-[2px]" />
        停止
      </button>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Workbench() {
  const {
    aggModels,
    currentModel,
    currentProviderId,
    modelsLoaded,
    sessionId,
    dir,
    opening,
    running,
    entries,
    files,
    tokens,
    progressAction,
    turnStartedAt,
    error,
    notice,
    loadModels,
    setModelSel,
    pickAndOpen,
    switchModel,
    send,
    abort,
    exportHtml,
    close,
    clearNotice,
  } = useWorkbenchStore()

  const [draft, setDraft] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isTauri) return
    loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, running, autoScroll])

  useEffect(() => {
    if (!notice && !error) return
    const t = window.setTimeout(() => clearNotice(), 3600)
    return () => window.clearTimeout(t)
  }, [notice, error]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAutoScroll(nearBottom)
  }

  const scrollToEntry = (entryId: string) => {
    const el = document.getElementById(`wb-entry-${entryId}`)
    if (el) {
      setAutoScroll(false)
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const showToast = (msg: string) => useWorkbenchStore.setState({ notice: msg })

  const onComposerSend = (content: string) => {
    setAutoScroll(true)
    void send(content)
  }

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-gray-950">
        <p className="text-gray-400 text-sm">请在桌面应用中使用</p>
        <p className="text-gray-600 text-xs">
          本地工作台需要 Tauri 桌面运行时，无法在普通浏览器中运行。
        </p>
      </div>
    )
  }

  const noProviders = modelsLoaded && aggModels.length === 0

  return (
    <div className="flex h-full bg-gray-950 text-gray-100">
      {sessionId && <FileTree files={files} onPick={scrollToEntry} />}

      <div className="flex flex-col flex-1 min-w-0 h-full">
        {/* Top bar */}
        <div className="px-3 py-2 border-b border-gray-800 flex-shrink-0 flex items-center gap-2 min-h-[48px]">
          <button
            onClick={() => void pickAndOpen()}
            disabled={opening || noProviders}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[12px] text-gray-200 transition-colors disabled:opacity-40 max-w-[280px]"
            title={dir ?? '选择工作目录'}
          >
            <span aria-hidden="true">📁</span>
            <span className="truncate">{dir ? baseName(dir) : '选择文件夹'}</span>
          </button>

          {dir && (
            <span
              className="text-[11px] text-gray-600 font-mono truncate max-w-[220px] hidden lg:block"
              title={dir}
            >
              {dir}
            </span>
          )}

          <div className="flex-1" />

          {opening && (
            <span className="text-[11px] text-emerald-400 animate-pulse flex-shrink-0">
              引擎启动中…
            </span>
          )}

          <select
            disabled
            title="思考级别（暂不可用：后端未开放该命令）"
            className="flex-shrink-0 bg-gray-800/60 border border-gray-800 rounded-lg px-2 py-1.5 text-[11px] text-gray-500 cursor-not-allowed"
          >
            <option>思考: 默认</option>
          </select>

          <ModelPicker
            models={aggModels}
            value={{ providerId: currentProviderId ?? '', modelId: currentModel }}
            onChange={(v) => {
              if (sessionId) void switchModel(v.providerId, v.modelId)
              else setModelSel(v.providerId, v.modelId)
            }}
            className="flex-shrink-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:border-emerald-500 transition-colors max-w-[200px]"
            title="选择模型（切换会新开会话）"
          />

          <TokenBadge tokens={tokens} />

          {sessionId && (
            <>
              <button
                onClick={() => void exportHtml()}
                className="flex-shrink-0 text-[11px] text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-2 py-1.5 transition-colors"
                title="导出会话为 HTML"
              >
                导出 HTML
              </button>
              <button
                onClick={() => void close()}
                className="flex-shrink-0 text-[11px] text-gray-500 hover:text-red-300 border border-gray-800 rounded-lg px-2 py-1.5 transition-colors"
                title="关闭当前工作台会话"
              >
                关闭
              </button>
            </>
          )}
        </div>

        {/* Body */}
        {noProviders ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
            <p className="text-gray-300 text-sm mb-1">尚未配置任何服务商</p>
            <p className="text-gray-500 text-xs">
              请先到「设置」添加服务商与 API Key，工作台才能驱动本地 AI。
            </p>
          </div>
        ) : !sessionId ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
            <div className="text-4xl mb-4">🖥️</div>
            <h1 className="text-lg font-semibold text-gray-200 mb-1.5">本地工作台</h1>
            <p className="text-sm text-gray-500 mb-6 max-w-md leading-6">
              选择一个文件夹，让 AI 在本地帮你改代码、跑命令、写文件。
              全过程可见——思考、命令、文件改动都会实时展示。
            </p>
            <button
              onClick={() => void pickAndOpen()}
              disabled={opening || !currentModel}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              选择文件夹开始
            </button>
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-h-0">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="absolute inset-0 overflow-y-auto"
              >
                <div className="max-w-4xl mx-auto px-4 py-5">
                  {entries.length === 0 && (
                    <p className="text-gray-600 text-[13px] text-center mt-10 select-none">
                      向下方输入你的任务，例如「把 README 翻译成英文」或「修复 build 报错」。
                    </p>
                  )}
                  {entries.map((e) => (
                    <EntryItem key={e.id} entry={e} />
                  ))}
                </div>
              </div>

              {!autoScroll && (
                <button
                  onClick={() => {
                    const el = scrollRef.current
                    if (el) el.scrollTop = el.scrollHeight
                    setAutoScroll(true)
                  }}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 shadow-lg transition-colors"
                  title="回到底部"
                >
                  ↓
                </button>
              )}
            </div>

            {running && (
              <ProgressBar
                action={progressAction}
                startedAt={turnStartedAt}
                total={tokens.total}
                onStop={() => void abort()}
              />
            )}

            <Composer
              draft={draft}
              setDraft={setDraft}
              busy={false}
              disabled={opening}
              onSend={(content: string, _atts: Attachment[]) => onComposerSend(content)}
              showToast={showToast}
              attachmentsEnabled={false}
              requireContent
              footerHint={null}
              maxWidthClass="max-w-4xl"
              placeholder={
                running
                  ? '输入插话内容，Enter 发送（会打断当前任务）'
                  : '交代一个任务，Enter 发送'
              }
            />
          </>
        )}
      </div>

      {(notice || error) && (
        <div
          className={[
            'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg border text-sm shadow-xl max-w-[80vw] break-words',
            error
              ? 'bg-red-950/90 border-red-800 text-red-200'
              : 'bg-gray-800 border-gray-700 text-gray-200',
          ].join(' ')}
        >
          {error ?? notice}
        </div>
      )}
    </div>
  )
}
