// /pi 中栏时间线：user 气泡 / assistant markdown 流式 / tool 可折叠单行 / system 条目。
// markdown 渲染复用 ui/MarkdownLite（同一套 GFM/公式/高亮管线）。
import { useEffect, useRef, useState } from 'react'
import { usePiStore, type PiTimelineItem } from '../../stores/piStore'
import { MarkdownLite } from '../ui/MarkdownLite'

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
  const { icon, tone } = toolIcon(item.toolName)
  const summary = argsSummary(item.args)
  const argsText = prettyArgs(item.args)
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
        {summary && (
          <span className="text-[11.5px] text-ink-dim font-mono truncate flex-1" title={summary}>
            {summary}
          </span>
        )}
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

function TimelineRow({
  item,
  sessionId,
}: {
  item: PiTimelineItem
  sessionId: string
}) {
  const toggleToolCollapse = usePiStore((s) => s.toggleToolCollapse)
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
      return (
        <div className="mt-2">
          <MarkdownLite text={item.text} />
          {item.streaming && <Blink />}
        </div>
      )
    case 'tool':
      return (
        <ToolRow item={item} onToggle={() => toggleToolCollapse(sessionId, item.id)} />
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
