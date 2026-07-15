// /pi 中栏时间线：user 气泡 / assistant markdown 流式 / tool 可折叠单行 / system 条目。
// markdown 渲染复用 ui/MarkdownLite（同一套 GFM/公式/高亮管线）。
// ②：assistant 正文与 tool 条目里的文件路径渲染为可点链接 → 右栏「文件」tab 预览。
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePiStore, type PiTimelineItem } from '../../stores/piStore'
import { MarkdownLite } from '../ui/MarkdownLite'
import {
  linkifyPaths,
  looksLikeFilePath,
  pathFromToolArgs,
  PI_OPEN_PREFIX,
} from './pathLinks'

const EMPTY_ITEMS: PiTimelineItem[] = []

function Blink() {
  return (
    <span className="inline-block w-[7px] h-[14px] ml-0.5 -mb-0.5 bg-primary/80 animate-pulse rounded-[1px] align-middle" />
  )
}

// ── 工具条目 ──────────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, { icon: string; tone: string }> = {
  bash: { icon: '$', tone: 'text-sky' },
  edit: { icon: '✎', tone: 'text-gold' },
  write: { icon: '＋', tone: 'text-mint' },
  read: { icon: '☰', tone: 'text-ink-dim' },
}

/** 彩色 diff 视图：+行绿底 / -行红底，行号，等宽字体。 */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <div className="overflow-x-auto text-[11px] leading-[1.6] font-mono">
      {lines.map((line, i) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++')
        const isDel = line.startsWith('-') && !line.startsWith('---')
        const isHunk = line.startsWith('@@')
        let bg = ''
        let fg = 'text-ink-muted'
        if (isAdd) { bg = 'bg-mint/12'; fg = 'text-mint' }
        else if (isDel) { bg = 'bg-coral/12'; fg = 'text-coral' }
        else if (isHunk) { fg = 'text-lavender' }
        return (
          <div key={i} className={`flex ${bg}`}>
            <span className="w-8 flex-shrink-0 text-right pr-2 text-ink-faint select-none">{i + 1}</span>
            <pre className={`flex-1 whitespace-pre-wrap break-words ${fg}`}>{line}</pre>
          </div>
        )
      })}
    </div>
  )
}

function toolIcon(name: string): { icon: string; tone: string } {
  return TOOL_ICONS[name] ?? { icon: '⚙', tone: 'text-lavender' }
}

/** args → 单行摘要：优先 path/cmd 类字段，退化为单行 JSON。 */
function argsSummary(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  if (typeof args === 'object') {
    const a = args as Record<string, unknown>
    for (const k of ['path', 'file_path', 'filePath', 'cmd', 'command', 'pattern', 'url']) {
      const v = a[k]
      if (typeof v === 'string' && v) return v
    }
    try {
      const s = JSON.stringify(args)
      return s.length > 96 ? s.slice(0, 96) + '…' : s
    } catch {
      return ''
    }
  }
  return String(args)
}

function prettyArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function ToolRow({
  item,
  onToggle,
}: {
  item: Extract<PiTimelineItem, { kind: 'tool' }>
  onToggle: () => void
}) {
  const openFileInPanel = usePiStore((s) => s.openFileInPanel)
  const { icon, tone } = toolIcon(item.toolName)
  const summary = argsSummary(item.args)
  const argsText = prettyArgs(item.args)
  // edit/write/read 等的 path 参数 → 摘要渲染为可点链接（右栏预览）。
  const pathArg = pathFromToolArgs(item.args)
  return (
    <div
      className={[
        'my-1.5 rounded-card border overflow-hidden',
        item.isError ? 'border-coral/40 bg-coral/5' : 'border-line bg-surface/60',
      ].join(' ')}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2/60 transition-colors"
      >
        <span className="text-[10px] text-ink-dim w-2.5 flex-shrink-0" aria-hidden="true">
          {item.collapsed ? '▸' : '▾'}
        </span>
        <span className={`text-[12px] flex-shrink-0 ${tone}`} aria-hidden="true">
          {icon}
        </span>
        <span className="text-[12px] text-ink font-mono flex-shrink-0">{item.toolName}</span>
        {summary &&
          (pathArg && summary === pathArg ? (
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                void openFileInPanel(pathArg)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  void openFileInPanel(pathArg)
                }
              }}
              className="text-[11.5px] text-sky hover:underline underline-offset-2 font-mono truncate flex-1 cursor-pointer"
              title={`${pathArg}\n点击在右栏预览`}
            >
              {summary}
            </span>
          ) : (
            <span
              className="text-[11.5px] text-ink-dim font-mono truncate flex-1"
              title={summary}
            >
              {summary}
            </span>
          ))}
        <span className="flex-shrink-0 ml-auto pl-2">
          {item.running ? (
            <span className="w-1.5 h-1.5 rounded-full bg-running animate-pulse inline-block" />
          ) : item.isError ? (
            <span className="text-[11px] text-coral">✕</span>
          ) : (
            <span className="text-[11px] text-mint">✓</span>
          )}
        </span>
      </button>
      {!item.collapsed && (
        <div className="border-t border-line/70">
          {argsText && (
            <div className="px-2.5 py-1.5">
              <div className="text-[10px] text-ink-faint mb-0.5 select-none">参数</div>
              <pre className="overflow-x-auto text-[11.5px] leading-relaxed font-mono text-ink-muted whitespace-pre-wrap break-words max-h-48">
                {argsText}
              </pre>
            </div>
          )}
          {item.result != null && item.result !== '' && (
            <div className="px-2.5 py-1.5 border-t border-line/50">
              <div className="text-[10px] text-ink-faint mb-0.5 select-none">
                {item.isError ? '结果（出错）' : '结果'}
              </div>
              <pre
                className={[
                  'overflow-x-auto text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-72',
                  item.isError ? 'text-coral' : 'text-ink-muted',
                ].join(' ')}
              >
                {item.result}
              </pre>
            </div>
          )}
          {typeof (item as Record<string, unknown>).diff === 'string' && (item as Record<string, unknown>).diff !== '' && (
            <div className="px-2.5 py-1.5 border-t border-line/50">
              <div className="text-[10px] text-ink-faint mb-0.5 select-none">文件变更 (diff)</div>
              <div className="max-h-72 overflow-y-auto">
                <DiffView diff={(item as Record<string, unknown>).diff as string} />
              </div>
            </div>
          )}
          {(item.toolName === 'write') && !item.result && !(item as Record<string, unknown>).diff && !item.running && (
            <div className="px-2.5 py-1.5 border-t border-line/50">
              <span className="inline-block px-1.5 py-0.5 rounded-chip bg-mint/15 text-mint text-[10.5px]">新建文件</span>
            </div>
          )}
          {item.running && (
            <div className="px-2.5 py-1.5 text-[11px] text-ink-dim border-t border-line/50">
              执行中…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 单条渲染 ──────────────────────────────────────────────────────────────────

/** assistant 正文：裸路径 linkify + 事件委托拦截 #pi-open: 链接与行内代码点击。 */
function AssistantBody({ text, streaming }: { text: string; streaming: boolean }) {
  const openFileInPanel = usePiStore((s) => s.openFileInPanel)

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest('a, code')
      if (!el) return
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') ?? ''
        const i = href.indexOf(PI_OPEN_PREFIX)
        if (i >= 0) {
          e.preventDefault()
          e.stopPropagation()
          void openFileInPanel(decodeURIComponent(href.slice(i + PI_OPEN_PREFIX.length)))
        }
        return
      }
      // 行内代码：形似文件路径则尝试打开（代码块 pre>code 不拦截）。
      if (el.parentElement?.tagName === 'PRE') return
      const t = (el.textContent ?? '').trim()
      if (looksLikeFilePath(t)) void openFileInPanel(t)
    },
    [openFileInPanel],
  )

  return (
    <div className="mt-2" onClick={onClick}>
      <MarkdownLite text={linkifyPaths(text)} />
      {streaming && <Blink />}
    </div>
  )
}

function TimelineRow({
  item,
  sessionId,
}: {
  item: PiTimelineItem
  sessionId: string
}) {
  const toggleToolCollapse = usePiStore((s) => s.toggleToolCollapse)
  const decideApproval = usePiStore((s) => s.decideApproval)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end mt-4">
          <div className="max-w-[85%] rounded-card rounded-tr-sm bg-grad-primary text-white px-3 py-2 text-[13.5px] whitespace-pre-wrap break-words">
            {item.text}
          </div>
        </div>
      )
    case 'assistant':
      if (item.thinking) {
        return (
          <div className="my-2 rounded-card border border-lavender/25 bg-lavender/5 overflow-hidden">
            <button
              type="button"
              onClick={() => setThinkingOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-lavender hover:bg-lavender/10"
            >
              <span>{thinkingOpen ? '▾' : '▸'}</span>
              <span className="font-medium">思考过程</span>
              {item.streaming && <Blink />}
            </button>
            {thinkingOpen && (
              <div className="px-3 pb-3 text-[12px] text-ink-dim whitespace-pre-wrap break-words leading-5">
                {item.text}
              </div>
            )}
          </div>
        )
      }
      return <AssistantBody text={item.text} streaming={item.streaming} />
    case 'tool':
      return (
        <ToolRow item={item} onToggle={() => toggleToolCollapse(sessionId, item.id)} />
      )
    case 'approval':
      return (
        <div className="my-3 rounded-card border border-gold/50 bg-gold/10 px-3 py-3">
          <div className="text-[13px] font-semibold text-gold">⚠ {item.title}</div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-dim font-mono">{item.detail}</pre>
          {item.status === 'pending' ? (
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => void decideApproval(sessionId, item.requestId, true)} className="rounded-md bg-mint px-3 py-1.5 text-[12px] font-semibold text-bg">允许</button>
              <button type="button" onClick={() => void decideApproval(sessionId, item.requestId, false)} className="rounded-md border border-coral/60 px-3 py-1.5 text-[12px] text-coral">拒绝</button>
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-ink-dim">{item.status === 'approved' ? '已允许' : item.status === 'expired' ? '已超时自动拒绝' : '已拒绝'}</div>
          )}
        </div>
      )
    case 'system':
      return (
        <div className="my-2 rounded-card border border-coral/40 bg-coral/10 px-3 py-2 text-[12.5px] text-coral whitespace-pre-wrap break-words">
          {item.text}
        </div>
      )
    default:
      return null
  }
}

// ── 时间线（滚动区 + 自动滚底） ───────────────────────────────────────────────

export default function PiTimeline() {
  const activeSessionId = usePiStore((s) => s.activeSessionId)
  const openFileInPanel = usePiStore((s) => s.openFileInPanel)
  const items = usePiStore((s) =>
    s.activeSessionId ? s.timelineById[s.activeSessionId] ?? EMPTY_ITEMS : EMPTY_ITEMS,
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // 切换会话时回到底部并恢复跟随。
  useEffect(() => {
    setAutoScroll(true)
  }, [activeSessionId])

  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, autoScroll, activeSessionId])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAutoScroll(nearBottom)
  }

  if (!activeSessionId) return null

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto px-4 py-3"
      >
        <div className="max-w-3xl mx-auto pb-4">
          {items.length === 0 ? (
            <div className="text-ink-dim text-[12.5px] text-center mt-12 leading-6 select-none">
              交代一个任务，agent 会在项目目录里读代码、改文件、跑命令。
            </div>
          ) : (
            items.map((it) => (
              <TimelineRow key={it.id} item={it} sessionId={activeSessionId} />
            ))
          )}
          {/* ── 改动文件汇总 ── */}
          {(() => {
            const fileOps: Array<{ path: string; op: string; id: string }> = []
            const seen = new Set<string>()
            for (const it of items) {
              if (it.kind !== 'tool') continue
              const p = pathFromToolArgs(it.args)
              if (!p) continue
              const op = it.toolName === 'write' ? 'write' : it.toolName === 'edit' ? 'edit' : it.toolName === 'read' ? 'read' : 'other'
              const key = `${p}::${op}`
              if (seen.has(key)) continue
              seen.add(key)
              fileOps.push({ path: p, op, id: it.id })
            }
            if (fileOps.length === 0) return null
            const opLabel: Record<string, string> = { write: '新建', edit: '编辑', read: '读取', other: '操作' }
            const opColor: Record<string, string> = { write: 'text-mint', edit: 'text-gold', read: 'text-ink-dim', other: 'text-lavender' }
            return (
              <div className="mt-4 pt-3 border-t border-line/50">
                <div className="text-[10.5px] text-ink-faint mb-1.5 select-none">改动文件汇总</div>
                <div className="space-y-1">
                  {fileOps.map((f) => (
                    <div key={f.id + f.path} className="flex items-center gap-2 text-[11.5px]">
                      <span className={`flex-shrink-0 w-7 text-right ${opColor[f.op] || 'text-ink-dim'}`}>
                        {opLabel[f.op] || f.op}
                      </span>
                      <span
                        role="link"
                        tabIndex={0}
                        onClick={() => void openFileInPanel(f.path)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void openFileInPanel(f.path) }}
                        className="font-mono text-sky hover:underline underline-offset-2 truncate cursor-pointer"
                        title={f.path}
                      >
                        {f.path.split(/[\\/]/).pop() || f.path}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      </div>
      {!autoScroll && (
        <button
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTop = el.scrollHeight
            setAutoScroll(true)
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-surface-2 border border-line text-ink hover:text-primary shadow-pop transition-colors"
          title="回到底部"
        >
          ↓
        </button>
      )}
    </div>
  )
}
