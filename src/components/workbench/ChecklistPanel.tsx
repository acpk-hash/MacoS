// 工作区任务清单（Claude Code 式逐条打勾）。
// 数据源自 workbenchStore.checklist：每个工具调用 = 一行，
// tool_started=进行中（蓝点脉冲），tool_result/edit/write=完成（绿勾）/失败（红叉）。
// 纯展示 + 点击跳转到对应输出卡片；蓝白科研主题。
import React from 'react'
import type { ChecklistItem, ChecklistTurn } from '../../stores/workbenchStore'

/** 单行状态图标：转圈/绿勾/红叉。尊重 reduced-motion。 */
const StepIcon = React.memo(function StepIcon({
  status,
}: {
  status: ChecklistItem['status']
}) {
  if (status === 'running') {
    return (
      <span
        className="inline-flex items-center justify-center flex-shrink-0"
        style={{ width: 14, height: 14 }}
        aria-label="进行中"
      >
        <span
          className="block rounded-full border-2 border-sky/30 border-t-sky motion-safe:animate-spin"
          style={{ width: 12, height: 12 }}
        />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span
        className="inline-flex items-center justify-center flex-shrink-0 rounded-full bg-coral/15 text-coral text-[10px] font-bold cl-pop"
        style={{ width: 14, height: 14 }}
        aria-label="失败"
      >
        ✕
      </span>
    )
  }
  // done
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 rounded-full bg-mint/15 text-mint text-[10px] font-bold cl-pop"
      style={{ width: 14, height: 14 }}
      aria-label="完成"
    >
      ✓
    </span>
  )
})

const StepRow = React.memo(function StepRow({
  item,
  onJump,
}: {
  item: ChecklistItem
  onJump: (entryId: string | null) => void
}) {
  const clickable = !!item.entryId
  const done = item.status === 'done'
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onJump(item.entryId)}
      className={[
        'group flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-left transition-colors',
        clickable ? 'hover:bg-surface-2 cursor-pointer' : 'cursor-default',
      ].join(' ')}
      title={clickable ? '查看该步骤详情' : undefined}
    >
      <StepIcon status={item.status} />
      <span
        className={[
          'flex-1 truncate text-[12px] leading-5',
          item.status === 'running'
            ? 'text-ink'
            : item.status === 'failed'
            ? 'text-coral'
            : 'text-ink-muted',
          done ? 'line-through decoration-mint/40' : '',
        ].join(' ')}
      >
        {item.title}
      </span>
    </button>
  )
})

const TurnGroup = React.memo(function TurnGroup({
  turn,
  index,
  total,
  onJump,
}: {
  turn: ChecklistTurn
  index: number
  total: number
  onJump: (entryId: string | null) => void
}) {
  const doneCount = turn.items.filter((i) => i.status === 'done').length
  const failCount = turn.items.filter((i) => i.status === 'failed').length
  const all = turn.items.length
  const finished = doneCount + failCount
  return (
    <div className="rounded-card border border-line bg-surface/60 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-2 border-b border-line">
        <span className="text-[11px] text-sky" aria-hidden="true">
          ☑
        </span>
        <span className="text-[11.5px] text-ink-muted font-medium flex-1">
          {total > 1 ? `任务清单 · 第 ${index + 1} 轮` : '任务清单'}
        </span>
        <span className="text-[10.5px] text-ink-dim font-mono">
          {finished}/{all} 完成{failCount > 0 ? ` · ${failCount} 失败` : ''}
        </span>
      </div>
      <div className="px-1.5 py-1 space-y-0.5">
        {turn.items.map((it) => (
          <StepRow key={it.id || it.title} item={it} onJump={onJump} />
        ))}
      </div>
    </div>
  )
})

/** 清单面板：按轮分组渲染。无步骤时不渲染。 */
const ChecklistPanel = React.memo(function ChecklistPanel({
  checklist,
  onJump,
}: {
  checklist: ChecklistTurn[]
  onJump: (entryId: string | null) => void
}) {
  const turns = checklist.filter((t) => t.items.length > 0)
  if (turns.length === 0) return null
  return (
    <div className="mb-2 space-y-2">
      {turns.map((t, i) => (
        <TurnGroup
          key={t.id}
          turn={t}
          index={i}
          total={turns.length}
          onJump={onJump}
        />
      ))}
    </div>
  )
})

export default ChecklistPanel
