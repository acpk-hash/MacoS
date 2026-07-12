// 实时日志：等宽自动滚底、关键词过滤、暂停滚动、清空；行内容已在 store 里
// 做过 JSON 美化（type/text 提取），此处叠加阶段过滤（来自流水线卡片点击）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { PHASES, useAutoStore } from '../../stores/autoStore'
import { IconSearch, IconX } from './icons'

const NL = String.fromCharCode(10)
/** 渲染上限：只画最近这么多行，防大 DOM。 */
const RENDER_CAP = 800

export default function LiveLog() {
  const log = useAutoStore((s) => s.log)
  const phaseFilter = useAutoStore((s) => s.phaseFilter)
  const runStatus = useAutoStore((s) => s.runStatus)
  const runId = useAutoStore((s) => s.runId)

  const [keyword, setKeyword] = useState('')
  const [paused, setPaused] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    let rows = log
    if (phaseFilter) rows = rows.filter((l) => l.phase === phaseFilter)
    if (kw) rows = rows.filter((l) => l.text.toLowerCase().includes(kw))
    return rows.length > RENDER_CAP ? rows.slice(rows.length - RENDER_CAP) : rows
  }, [log, phaseFilter, keyword])

  // 自动滚底（未暂停时）。
  useEffect(() => {
    if (paused) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filtered, paused])

  // 用户往上滚视为暂停，滚回底部自动恢复。
  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom && paused) setPaused(false)
    else if (!atBottom && !paused) setPaused(true)
  }

  const phaseLabel = phaseFilter
    ? PHASES.find((p) => p.id === phaseFilter)?.label ?? phaseFilter
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-card border border-line bg-surface">
      {/* 头部：标题 + 阶段过滤徽章 + 关键词过滤 + 暂停/清空 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[12px] font-semibold text-ink">实时日志</span>
        {runStatus === 'running' && runId && (
          <span className="text-[10.5px] text-ink-dim font-mono">
            run {runId.slice(0, 8)}
          </span>
        )}
        {phaseLabel && (
          <button
            className="flex items-center gap-1 rounded-full bg-primary-tint px-2 py-0.5 text-[10.5px] text-primary font-medium"
            onClick={() => useAutoStore.getState().setPhaseFilter(null)}
            title="取消阶段过滤"
          >
            阶段：{phaseLabel}
            <IconX size={10} />
          </button>
        )}
        <div className="flex-1" />
        <div className="relative">
          <IconSearch
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            className="w-[160px] rounded-input border border-line bg-surface-2 py-1 pl-6 pr-2 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-primary/50"
            placeholder="关键词过滤"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <button
          className={
            'rounded-input border px-2 py-1 text-[11px] transition-colors ' +
            (paused
              ? 'border-awaiting/40 bg-[#b7791f1a] text-awaiting'
              : 'border-line text-ink-dim hover:text-ink hover:bg-surface-2')
          }
          onClick={() => setPaused((v) => !v)}
          title={paused ? '恢复自动滚动' : '暂停自动滚动'}
        >
          {paused ? '已暂停' : '暂停滚动'}
        </button>
        <button
          className="rounded-input border border-line px-2 py-1 text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors"
          onClick={() => useAutoStore.getState().clearLog()}
          title="清空当前日志（不影响历史台账）"
        >
          清空
        </button>
      </div>

      {/* 日志体 */}
      <div
        ref={bodyRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-5"
      >
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-[11.5px] text-ink-faint font-sans">
            {log.length === 0
              ? runStatus === 'running'
                ? '等待输出…'
                : '暂无日志 — 配置研究方向后点「开始研究」'
              : '没有匹配当前过滤条件的日志行'}
          </div>
        ) : (
          filtered.map((l) => (
            <div
              key={l.id}
              className={
                'whitespace-pre-wrap break-words ' +
                (l.stderr ? 'text-failed' : 'text-ink-muted')
              }
            >
              {l.text.split(NL).length > 12
                ? l.text.split(NL).slice(0, 12).join(NL) + NL + '…'
                : l.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
