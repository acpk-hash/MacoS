// Bottom timeline bar: one colored block per step in ts order.
// Click a block to select + center its node; hover shows a tooltip.

import type { TimelineSeg } from './types'

function segColor(seg: TimelineSeg): string {
  if (seg.status === 'failed') return 'bg-red-500'
  if (seg.stepKind === 'reply') return 'bg-sky-500'
  if (seg.stepKind === 'command') return 'bg-emerald-500'
  return 'bg-purple-500'
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '0 秒'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m} 分 ${rs} 秒`
  const h = Math.floor(m / 60)
  return `${h} 时 ${m % 60} 分`
}

export default function Timeline({
  segs,
  totalMs,
  selectedNodeId,
  onSelect,
}: {
  segs: TimelineSeg[]
  totalMs: number
  selectedNodeId: string | null
  onSelect: (nodeId: string) => void
}) {
  return (
    <div className="h-14 bg-gray-900/95 border-t border-gray-800 px-3 py-2 flex items-center gap-3 z-10">
      <div className="text-[11px] text-gray-500 whitespace-nowrap">
        时间轴 · {segs.length} 步 · 总时长 {fmtDuration(totalMs)}
      </div>
      <div className="flex-1 flex items-stretch gap-0.5 overflow-x-auto h-6">
        {segs.length === 0 && (
          <div className="text-[11px] text-gray-600 self-center">暂无步骤</div>
        )}
        {segs.map((seg) => (
          <button
            key={seg.nodeId}
            title={seg.label}
            onClick={() => onSelect(seg.nodeId)}
            className={`h-full min-w-[10px] flex-1 rounded-sm transition-opacity hover:opacity-100 ${segColor(
              seg,
            )} ${selectedNodeId === seg.nodeId ? 'opacity-100 ring-2 ring-white' : 'opacity-70'}`}
          />
        ))}
      </div>
    </div>
  )
}
