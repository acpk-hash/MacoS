// 阶段流水线视图：explore→literature-review→critique→write→reviewer 横排卡片。
// 状态点（等待/进行中脉冲/完成/出错）+ 每阶段起止耗时（由 os-event 日志行的
// subagent 名推进，见 autoStore.lineHitsPhase）；点击卡片过滤下方日志。
import { useEffect, useState } from 'react'
import { PHASES, useAutoStore, type PhaseState } from '../../stores/autoStore'
import { StatusDot, type StatusKind } from '../ui'
import { fmtDuration } from './format'

function dotStatus(p: PhaseState): StatusKind {
  if (p.status === 'active') return 'running'
  if (p.status === 'done') return 'done'
  if (p.status === 'error') return 'failed'
  return 'todo'
}

function statusText(p: PhaseState, running: boolean, now: number): string {
  if (p.status === 'pending') return '等待'
  if (p.status === 'active') {
    const base = running ? '进行中' : '已中断'
    return p.startedAt ? base + ' · ' + fmtDuration(now - p.startedAt) : base
  }
  const dur =
    p.startedAt && p.endedAt ? fmtDuration(p.endedAt - p.startedAt) : null
  if (p.status === 'error') return dur ? '出错 · ' + dur : '出错'
  return dur ? '完成 · ' + dur : '完成'
}

export default function PipelineView() {
  const phases = useAutoStore((s) => s.phases)
  const phaseFilter = useAutoStore((s) => s.phaseFilter)
  const runStatus = useAutoStore((s) => s.runStatus)
  const running = runStatus === 'running'

  // 进行中阶段的耗时每秒走字。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  return (
    <div className="grid grid-cols-5 gap-2">
      {PHASES.map((ph, i) => {
        const st = phases[ph.id]
        const selected = phaseFilter === ph.id
        return (
          <button
            key={ph.id}
            onClick={() =>
              useAutoStore.getState().setPhaseFilter(selected ? null : ph.id)
            }
            aria-pressed={selected}
            title={
              (selected ? '取消过滤：' : '过滤日志到阶段：') + ph.label
            }
            className={
              'rounded-card border px-3 py-2 text-left transition-colors ' +
              (selected
                ? 'border-primary bg-primary-tint'
                : st.status === 'active'
                  ? 'border-line-strong bg-surface'
                  : 'border-line bg-surface hover:border-line-strong hover:bg-elevated')
            }
          >
            <div className="flex items-center gap-1.5">
              <StatusDot
                status={dotStatus(st)}
                size={7}
                pulse={st.status === 'active' && running}
              />
              <span className="text-[12px] font-semibold text-ink truncate">
                {i + 1}. {ph.label}
              </span>
            </div>
            <div className="mt-1 text-[10.5px] text-ink-dim tabular-nums truncate">
              {statusText(st, running, now)}
            </div>
          </button>
        )
      })}
    </div>
  )
}
