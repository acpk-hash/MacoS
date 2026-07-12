// 运行历史台账（底部可折叠，借鉴 open-science RunsPage）：每次 os_run 一条，
// localStorage 持久化；按天分组 + 状态分面筛选；行展开显示当次日志尾部与
// 「Reproduce」（把 topic/workspace/model 回填顶部配置条）。
import { useMemo, useState } from 'react'
import {
  useAutoStore,
  type AutoRunRecord,
  type RunStatus,
} from '../../stores/autoStore'
import { StatusDot, type StatusKind } from '../ui'
import { dayLabel, fmtDuration, relativeTime } from './format'
import { IconChevronDown, IconChevronRight, IconRotate, IconTrash } from './icons'

const NL = String.fromCharCode(10)

const STATUS_META: Record<RunStatus, { label: string; dot: StatusKind }> = {
  running: { label: '运行中', dot: 'running' },
  done: { label: '完成', dot: 'done' },
  error: { label: '出错', dot: 'failed' },
  stopped: { label: '已停止', dot: 'idle' },
}

function groupByDay(rows: AutoRunRecord[]): Array<[string, AutoRunRecord[]]> {
  const groups: Array<[string, AutoRunRecord[]]> = []
  let cur: [string, AutoRunRecord[]] | null = null
  for (const r of rows) {
    const label = dayLabel(r.startedAt)
    if (!cur || cur[0] !== label) {
      cur = [label, []]
      groups.push(cur)
    }
    cur[1].push(r)
  }
  return groups
}

export default function RunHistory() {
  const history = useAutoStore((s) => s.history)
  const open = useAutoStore((s) => s.historyOpen)
  const runId = useAutoStore((s) => s.runId)
  const liveLog = useAutoStore((s) => s.log)

  const [facet, setFacet] = useState<RunStatus | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const counts = useMemo(() => {
    const c: Record<RunStatus, number> = { running: 0, done: 0, error: 0, stopped: 0 }
    for (const r of history) c[r.status]++
    return c
  }, [history])

  const rows = facet ? history.filter((r) => r.status === facet) : history
  const groups = useMemo(() => groupByDay(rows), [rows])

  if (history.length === 0) return null

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      {/* 折叠头 */}
      <button
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface-2 transition-colors"
        onClick={() => useAutoStore.getState().setHistoryOpen(!open)}
        aria-expanded={open}
      >
        {open ? (
          <IconChevronDown size={12} className="text-ink-dim" />
        ) : (
          <IconChevronRight size={12} className="text-ink-dim" />
        )}
        <span className="text-[12px] font-semibold text-ink">运行历史</span>
        <span className="text-[10.5px] text-ink-dim">{history.length} 次</span>
        {!open && counts.running > 0 && (
          <span className="flex items-center gap-1 text-[10.5px] text-running">
            <StatusDot status="running" size={5} pulse />
            {counts.running} 个运行中
          </span>
        )}
      </button>

      {open && (
        <div className="max-h-[280px] overflow-y-auto px-4 pb-3">
          {/* 状态分面 */}
          <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface pb-2">
            <FacetChip
              label="全部"
              count={history.length}
              active={facet === null}
              onClick={() => setFacet(null)}
            />
            {(Object.keys(STATUS_META) as RunStatus[])
              .filter((k) => counts[k] > 0)
              .map((k) => (
                <FacetChip
                  key={k}
                  label={STATUS_META[k].label}
                  count={counts[k]}
                  dot={STATUS_META[k].dot}
                  active={facet === k}
                  onClick={() => setFacet(facet === k ? null : k)}
                />
              ))}
          </div>

          {groups.map(([label, items]) => (
            <section key={label}>
              <div className="sticky top-[30px] z-[5] bg-surface py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
                {label}
              </div>
              <ul>
                {items.map((r) => (
                  <Row
                    key={r.id}
                    rec={r}
                    live={r.id === runId}
                    liveTail={
                      r.id === runId ? liveLog.slice(-40).map((l) => l.text) : null
                    }
                    open={expanded === r.id}
                    onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))}
                  />
                ))}
              </ul>
            </section>
          ))}
          {rows.length === 0 && (
            <div className="py-4 text-center text-[11px] text-ink-faint">
              没有匹配该状态的记录
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FacetChip({
  label,
  count,
  active,
  onClick,
  dot,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  dot?: StatusKind
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ' +
        (active
          ? 'border-line-strong bg-surface-2 text-ink font-medium'
          : 'border-line text-ink-dim hover:text-ink')
      }
    >
      {dot && <StatusDot status={dot} size={5} />}
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  )
}

function Row({
  rec,
  live,
  liveTail,
  open,
  onToggle,
}: {
  rec: AutoRunRecord
  live: boolean
  liveTail: string[] | null
  open: boolean
  onToggle: () => void
}) {
  const meta = STATUS_META[rec.status]
  const dur =
    rec.endedAt != null ? fmtDuration(rec.endedAt - rec.startedAt) : live ? '进行中' : null
  const tail = liveTail ?? rec.logTail

  return (
    <li>
      <button
        className="group flex w-full items-center gap-2 rounded-input px-1.5 py-1.5 text-left hover:bg-surface-2 transition-colors"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <IconChevronDown size={11} className="shrink-0 text-ink-dim" />
        ) : (
          <IconChevronRight
            size={11}
            className="shrink-0 text-ink-faint opacity-40 group-hover:opacity-100"
          />
        )}
        <StatusDot status={meta.dot} size={6} pulse={rec.status === 'running'} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={rec.topic}>
          {rec.topic}
        </span>
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-muted">
          {rec.model}
        </span>
        {rec.artifactCount > 0 && (
          <span className="shrink-0 text-[10.5px] text-ink-dim tabular-nums">
            {rec.artifactCount} 产物
          </span>
        )}
        {dur && <span className="shrink-0 text-[10.5px] text-ink-dim tabular-nums">{dur}</span>}
        <span className="w-14 shrink-0 text-right text-[10.5px] text-ink-dim">
          {relativeTime(rec.startedAt)}
        </span>
      </button>

      {open && (
        <div className="mb-1.5 ml-5 space-y-2 border-l border-line-soft pl-3 pt-1">
          <div className="text-[10.5px] text-ink-dim font-mono truncate" title={rec.workspace}>
            {rec.workspace}
          </div>
          <div className="flex items-center gap-3">
            <button
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
              onClick={() => useAutoStore.getState().reproduce(rec)}
              title="把该次的研究方向 / 工作目录 / 模型回填到顶部配置条"
            >
              <IconRotate size={11} />
              Reproduce 回填配置
            </button>
            {!live && (
              <button
                className="flex items-center gap-1 text-[11px] text-ink-dim hover:text-failed transition-colors"
                onClick={() => useAutoStore.getState().deleteHistory(rec.id)}
                title="从台账中删除该记录"
              >
                <IconTrash size={11} />
                删除记录
              </button>
            )}
            <span className="text-[10px] text-ink-faint">{meta.label}</span>
          </div>
          {tail.length > 0 && (
            <pre className="max-h-36 overflow-y-auto rounded-input border border-line bg-surface-2 p-2 font-mono text-[10.5px] leading-4 text-ink-muted whitespace-pre-wrap">
              {tail.join(NL)}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}
