// 右栏 AI 对话面板（G2b）— 取代旧的终端观感。
// 用户气泡 + AI 流式 markdown（含公式/高亮）+ 工具卡片做成 inline diff 卡。
import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import { useWorkbenchStore, type WorkbenchEntry } from '../../stores/workbenchStore'
import ChecklistPanel from './ChecklistPanel'
import ProviderGuideCard from '../ProviderGuideCard'
import Composer from '../Composer'
import type { Attachment } from '../../stores/studioStore'
import { normalizeMathDelimiters } from '../../lib/mathDelimiters'
import {
  MAX_TOTAL_TEXT_BYTES,
  isTextLikeFile,
  readTextSmart,
} from '../../lib/attachments'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [
  rehypeHighlight,
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
] as never

const mdComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
      {children}
    </pre>
  ),
  code(props) {
    const { className, children } = props
    const isBlock = /language-/.test(className || '')
    if (!isBlock) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-surface-2 text-[0.85em] font-mono text-mint">
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
  h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1.5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[15px] font-semibold mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} className="text-sky underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-lavender/40 pl-3 my-1.5 text-ink-muted">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 bg-surface-2 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
}

// 导出给 EditorPane 的 Markdown 预览复用（同一套 GFM/公式/高亮管线）。
export const MarkdownLite = React.memo(function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] text-ink break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={mdComponents}
      >
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </div>
  )
})

function Blink() {
  return (
    <span className="inline-block w-[7px] h-[14px] ml-0.5 -mb-0.5 bg-sakura/80 animate-pulse rounded-[1px] align-middle" />
  )
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

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
              add ? 'bg-mint/12 text-mint' : '',
              del ? 'bg-coral/12 text-coral' : '',
              !add && !del ? 'text-ink-muted' : '',
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
  tone,
  title,
  badge,
  children,
}: {
  icon: string
  tone: string
  title: React.ReactNode
  badge?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="my-2 rounded-card border border-line bg-surface/60 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-2 border-b border-line">
        <span className={`text-[12px] ${tone}`} aria-hidden="true">
          {icon}
        </span>
        <span className="text-[12px] text-ink-muted font-mono truncate flex-1">{title}</span>
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
  const [open, setOpen] = useState(true)
  const ok = exitCode == null || exitCode === 0
  return (
    <ToolShell
      icon="$"
      tone="text-sky"
      title={<span className="text-ink">{cmd}</span>}
      badge={
        <div className="flex items-center gap-1.5">
          {exitCode != null && (
            <span
              className={[
                'text-[10px] px-1.5 py-0.5 rounded-chip font-mono border',
                ok ? 'bg-mint/12 text-mint border-mint/25' : 'bg-coral/12 text-coral border-coral/25',
              ].join(' ')}
            >
              exit {exitCode}
            </span>
          )}
          {output.trim() && (
            <button onClick={() => setOpen((v) => !v)} className="text-[10px] text-ink-dim hover:text-ink">
              {open ? '收起' : '展开'}
            </button>
          )}
        </div>
      }
    >
      {open && output.trim() && (
        <pre className="overflow-x-auto p-2.5 text-[12px] leading-relaxed font-mono text-ink-muted whitespace-pre-wrap break-words max-h-72">
          {output}
        </pre>
      )}
    </ToolShell>
  )
})

const EditCard = React.memo(function EditCard({ path, diff }: { path: string; diff: string }) {
  return (
    <ToolShell
      icon="✎"
      tone="text-gold"
      title={<span className="text-gold" title={path}>{baseName(path)}</span>}
      badge={<span className="text-[10px] text-ink-dim">编辑</span>}
    >
      {diff.trim() ? (
        <DiffView diff={diff} />
      ) : (
        <div className="px-2.5 py-2 text-[12px] text-ink-dim">已修改文件</div>
      )}
    </ToolShell>
  )
})

const WriteCard = React.memo(function WriteCard({ path }: { path: string }) {
  return (
    <ToolShell
      icon="＋"
      tone="text-mint"
      title={<span className="text-mint" title={path}>{baseName(path)}</span>}
      badge={<span className="text-[10px] text-mint">新建</span>}
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
      tone={isError ? 'text-coral' : 'text-lavender'}
      title={<span className="text-ink-muted">{tool}</span>}
      badge={
        <button onClick={() => setOpen((v) => !v)} className="text-[10px] text-ink-dim hover:text-ink">
          {open ? '收起' : '详情'}
        </button>
      }
    >
      {open && output.trim() && (
        <pre
          className={[
            'overflow-x-auto p-2.5 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-72',
            isError ? 'text-coral' : 'text-ink-muted',
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
        className="flex items-center gap-1.5 text-[12px] text-lavender/80 hover:text-lavender"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>思考{streaming ? '中…' : '过程'}</span>
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 border-lavender/25 text-[12.5px] text-ink-dim whitespace-pre-wrap break-words leading-6">
          {text}
          {streaming && <Blink />}
        </div>
      )}
    </div>
  )
}
)

export const EntryItem = React.memo(function EntryItem({ entry }: { entry: WorkbenchEntry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="flex justify-end mt-4">
          <div className="max-w-[85%] rounded-card rounded-tr-sm bg-grad-primary text-white px-3 py-2 text-[13.5px] whitespace-pre-wrap break-words shadow-glow-primary">
            {entry.steer && (
              <span className="mr-1.5 text-[10px] px-1.5 py-0.5 rounded-chip bg-white/20 align-middle">
                插话
              </span>
            )}
            {entry.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="mt-2">
          <MarkdownLite text={entry.text} />
          {entry.streaming && <Blink />}
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={entry.text} streaming={entry.streaming} />
    case 'tool_bash':
      return <BashCard cmd={entry.cmd} output={entry.output} exitCode={entry.exitCode} />
    case 'tool_edit':
      return <EditCard path={entry.path} diff={entry.diff} />
    case 'tool_write':
      return <WriteCard path={entry.path} />
    case 'tool_result':
      return <ResultCard tool={entry.tool} output={entry.output} isError={entry.isError} />
    case 'error':
      return (
        <div className="my-2 rounded-card border border-coral/40 bg-coral/10 px-3 py-2 text-[13px] text-coral break-words">
          {entry.text}
        </div>
      )
    default:
      return null
  }
})

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

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
    <div className="flex items-center gap-2.5 px-3 py-2 border-t border-line bg-surface/60 flex-shrink-0">
      <span className="w-2 h-2 rounded-full bg-sakura animate-pulse flex-shrink-0 shadow-glow-sakura" />
      <span className="text-[12px] text-ink-muted truncate flex-1 font-mono">
        {action || '工作中…'}
      </span>
      <span className="text-[11px] text-ink-dim font-mono flex-shrink-0">
        {secs}s · Σ{fmt(total)}
      </span>
      <button
        onClick={onStop}
        className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-btn bg-surface-2 hover:bg-coral/15 border border-line hover:border-coral/30 text-[11px] text-ink-muted hover:text-coral transition-colors"
        title="停止当前任务"
      >
        <span className="w-2.5 h-2.5 bg-current rounded-[2px]" />
        停止
      </button>
    </div>
  )
}

// ── 拖入文件：工作目录内 → @相对路径引用；目录外 → 内联文本 ────────────────────

type WbAttach =
  | { id: string; kind: 'ref'; rel: string }
  | { id: string; kind: 'inline'; name: string; text: string }

function wbUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'wba-' + Math.random().toString(36).slice(2)
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/** 判断拖入的文件是否就是工作目录里的某个文件：
 *  按文件名搜索候选（ws_search），再逐个比对内容（ws_read_file）。
 *  命中 → 返回相对路径（codex 可直接读）；否则 null → 内联兜底。 */
async function matchWorkspaceFile(
  fileName: string,
  content: string,
): Promise<string | null> {
  if (useWorkspaceStore.getState().remote) return null // 远程(SSH)源不做本地判断
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const hits = await invoke<Array<{ rel_path: string; line: number | null }>>(
      'ws_search',
      { query: fileName, max: 80 },
    )
    const lower = fileName.toLowerCase()
    const cands = Array.from(
      new Set(
        hits
          .filter((h) => h.line == null)
          .map((h) => h.rel_path)
          .filter((rel) => (rel.split('/').pop() ?? '').toLowerCase() === lower),
      ),
    ).slice(0, 6)
    const want = normalizeEol(content)
    for (const rel of cands) {
      const fc = await invoke<{ content: string; too_large: boolean }>(
        'ws_read_file',
        { relPath: rel },
      )
      if (!fc.too_large && normalizeEol(fc.content) === want) return rel
    }
  } catch {
    /* 判断失败 → 按内联兜底 */
  }
  return null
}

export default function ChatPanel({
  draft,
  setDraft,
}: {
  draft: string
  setDraft: (v: string) => void
}) {
  const sessionId = useWorkbenchStore((s) => s.sessionId)
  const opening = useWorkbenchStore((s) => s.opening)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)
  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const running = useWorkbenchStore((s) => s.running)
  const entries = useWorkbenchStore((s) => s.entries)
  const checklist = useWorkbenchStore((s) => s.checklist)
  const tokens = useWorkbenchStore((s) => s.tokens)
  const progressAction = useWorkbenchStore((s) => s.progressAction)
  const turnStartedAt = useWorkbenchStore((s) => s.turnStartedAt)
  const send = useWorkbenchStore((s) => s.send)
  const abort = useWorkbenchStore((s) => s.abort)

  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const [wbAtts, setWbAtts] = useState<WbAttach[]>([])
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, running, autoScroll])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAutoScroll(nearBottom)
  }

  const jumpToEntry = (entryId: string | null) => {
    if (!entryId) return
    const root = scrollRef.current
    if (!root) return
    const node = root.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)
    if (!node) return
    setAutoScroll(false)
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.add('cl-flash')
    window.setTimeout(() => node.classList.remove('cl-flash'), 900)
  }

  const noModels = modelsLoaded && aggModels.length === 0

  const showToast = (msg: string) => useWorkbenchStore.setState({ notice: msg })

  /** 拖入/选择的文件 → 根内 @引用 或 根外内联文本。 */
  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return
    const notices: string[] = []
    const added: WbAttach[] = []
    let used = wbAtts.reduce(
      (n, a) => (a.kind === 'inline' ? n + a.text.length : n),
      0,
    )
    for (const f of files) {
      const name = f.name || '文件'
      if (f.type.startsWith('image/')) {
        notices.push(`「${name}」工作台暂不支持图片，已跳过`)
        continue
      }
      if (!isTextLikeFile(f)) {
        notices.push(`「${name}」暂不支持该类型，已跳过`)
        continue
      }
      const res = await readTextSmart(f)
      if ('error' in res) {
        notices.push(`「${name}」${res.error}，已跳过`)
        continue
      }
      // 根内检测（截断的文件无法比对内容，直接内联）。
      const rel = res.truncated ? null : await matchWorkspaceFile(name, res.text)
      if (rel) {
        if (!wbAtts.some((a) => a.kind === 'ref' && a.rel === rel) &&
            !added.some((a) => a.kind === 'ref' && a.rel === rel)) {
          added.push({ id: wbUuid(), kind: 'ref', rel })
        }
        continue
      }
      if (used + res.text.length > MAX_TOTAL_TEXT_BYTES) {
        notices.push(`「${name}」附件总量超出上限，已跳过`)
        continue
      }
      used += res.text.length
      if (res.truncated) {
        notices.push(`「${name}」超过 200KB，已截断（建议放进工作目录后拖入）`)
      }
      added.push({
        id: wbUuid(),
        kind: 'inline',
        name,
        text: res.truncated ? res.text + '\n……（文件过长，已截断）' : res.text,
      })
    }
    if (added.length > 0) setWbAtts((prev) => [...prev, ...added])
    if (notices.length > 0) showToast(notices.slice(0, 3).join('；'))
  }

  const removeAtt = (id: string) => {
    setWbAtts((prev) => prev.filter((a) => a.id !== id))
  }

  // 整个面板作为拖放区（用计数器避免子元素 enter/leave 抖动）。
  const dragHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }
  const onDrop = (e: React.DragEvent) => {
    dragDepth.current = 0
    setDropActive(false)
    if (!dragHasFiles(e)) return
    e.preventDefault()
    void handleFiles(Array.from(e.dataTransfer?.files ?? []))
  }

  /** 发送：把 @引用与内联文件并入提示词。 */
  const onSend = (content: string) => {
    setAutoScroll(true)
    const refs = wbAtts.filter((a) => a.kind === 'ref') as Array<
      Extract<WbAttach, { kind: 'ref' }>
    >
    const inlines = wbAtts.filter((a) => a.kind === 'inline') as Array<
      Extract<WbAttach, { kind: 'inline' }>
    >
    const parts: string[] = [content]
    if (refs.length > 0) {
      parts.push(
        '相关文件（位于工作目录内，可直接读取）：' +
          refs.map((r) => '@' + r.rel).join(' '),
      )
    }
    for (const f of inlines) {
      parts.push(
        `[附带文件 ${f.name}（工作目录外，内容已内联）]\n\`\`\`\`\n${f.text}\n\`\`\`\``,
      )
    }
    setWbAtts([])
    void send(parts.join('\n\n'))
  }

  return (
    <div
      className="relative w-[420px] flex-shrink-0 flex flex-col h-full glass border-l border-line"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line flex-shrink-0">
        <span className="text-[11px] text-sakura">✦</span>
        <span className="text-[12px] text-ink font-medium flex-1">AI 助手</span>
        {opening && <span className="text-[10.5px] text-lavender animate-pulse">内置引擎启动中…</span>}
        {sessionId && !opening && (
          <span className="text-[10.5px] text-mint">● 就绪</span>
        )}
      </div>

      {/* Conversation */}
      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto px-3 py-3">
          {entries.length === 0 ? (
            noModels ? (
              <div className="mt-8 px-1">
                <ProviderGuideCard
                  compact
                  title="还没有配置模型服务"
                  hint="AI 对话需要先添加一个 OpenAI 兼容服务商（Base URL + API Key）。"
                />
              </div>
            ) : (
              <div className="text-ink-dim text-[12.5px] text-center mt-10 leading-6 px-2 select-none">
                交代一个任务，AI 会直接在当前目录改代码、跑命令、写文件。
                <br />
                例如「修复 build 报错」或「给这个组件加暗色主题」。
                <br />
                也可以把文件拖进来一起交给 AI。
              </div>
            )
          ) : (
            <>
              <ChecklistPanel checklist={checklist} onJump={jumpToEntry} />
              {entries.map((e) => (
                <div key={e.id} data-entry-id={e.id}>
                  <EntryItem entry={e} />
                </div>
              ))}
            </>
          )}
        </div>
        {!autoScroll && (
          <button
            onClick={() => {
              const el = scrollRef.current
              if (el) el.scrollTop = el.scrollHeight
              setAutoScroll(true)
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 w-8 h-8 flex items-center justify-center rounded-full glass-strong text-ink hover:text-sakura shadow-glass transition-colors"
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

      {/* 拖入的文件 chips：@引用（根内） / 内联（根外） */}
      {wbAtts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2 border-t border-line bg-surface/40 flex-shrink-0">
          {wbAtts.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-chip bg-surface-2 border border-line text-[11px]"
            >
              {a.kind === 'ref' ? (
                <span
                  className="font-mono text-mint truncate max-w-[180px]"
                  title={`工作目录内文件，将以 @${a.rel} 引用`}
                >
                  @{a.rel}
                </span>
              ) : (
                <>
                  <span aria-hidden="true">📄</span>
                  <span className="text-ink-muted truncate max-w-[140px]" title={a.name}>
                    {a.name}
                  </span>
                  <span className="text-[10px] text-ink-dim">内联</span>
                </>
              )}
              <button
                onClick={() => removeAtt(a.id)}
                className="text-ink-dim hover:text-coral transition-colors"
                title="移除"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <Composer
        draft={draft}
        setDraft={setDraft}
        busy={false}
        disabled={opening || !sessionId}
        onSend={(content: string, _atts: Attachment[]) => onSend(content)}
        showToast={showToast}
        attachmentsEnabled={false}
        requireContent
        footerHint={null}
        maxWidthClass="max-w-full"
        renderPlusMenu={(close) => (
          <div className="w-48 py-1 rounded-lg bg-surface-2 border border-line shadow-xl">
            <button
              onClick={() => {
                close()
                fileInputRef.current?.click()
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
            >
              添加文件（引用 / 内联）
            </button>
          </div>
        )}
        placeholder={
          noModels
            ? '未配置模型服务——请到「设置」添加服务商'
            : !sessionId
            ? opening
              ? '内置引擎启动中…'
              : '会话未启动——请重新打开文件夹'
            : running
            ? '输入插话内容，Enter 发送（会打断当前任务）'
            : '交代一个任务，Enter 发送（可拖入文件）'
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) void handleFiles(files)
          e.target.value = ''
        }}
      />

      {/* 拖放遮罩 */}
      {dropActive && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px] pointer-events-none">
          <div className="mx-4 px-5 py-6 rounded-card border-2 border-dashed border-lavender/70 bg-surface/90 text-center">
            <div className="text-2xl mb-1.5" aria-hidden="true">📎</div>
            <p className="text-[13px] text-ink font-medium">拖放文件到这里</p>
            <p className="text-[11px] text-ink-dim mt-1 leading-5">
              工作目录内的文件将以 @路径 引用
              <br />
              目录外的文本文件将内联其内容
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
