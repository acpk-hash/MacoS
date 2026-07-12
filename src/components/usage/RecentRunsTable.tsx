// 最近运行表格（自旧 Dashboard 恢复；状态/类型标签沿用旧口径）。

import { fmtDate, fmtDuration, fmtTokens } from './format'
import type { RecentRun } from './types'

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  ended: '已结束',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  awaiting_review: '待确认',
  todo: '待办',
  queued: '排队中',
}

function statusClass(s: string): string {
  if (s === 'failed') return 'bg-[#d0342c1a] text-failed'
  if (s === 'running' || s === 'active') return 'bg-[#0d8de31a] text-running'
  if (s === 'awaiting_review') return 'bg-[#b7791f1a] text-awaiting'
  return 'bg-elevated/60 text-ink-muted'
}

export default function RecentRunsTable({ runs }: { runs: RecentRun[] }) {
  if (runs.length === 0) {
    return <div className="text-[12px] text-ink-dim">暂无运行记录</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] text-ink-dim border-b border-line">
            <th className="py-2 pr-3 font-medium">标题</th>
            <th className="py-2 pr-3 font-medium">类型</th>
            <th className="py-2 pr-3 font-medium">模型</th>
            <th className="py-2 pr-3 font-medium text-right">Token</th>
            <th className="py-2 pr-3 font-medium text-right">时长</th>
            <th className="py-2 pr-3 font-medium">状态</th>
            <th className="py-2 font-medium text-right">时间</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.kind + ':' + r.id}
              className="border-b border-line/60 last:border-0 hover:bg-surface/60 transition-colors"
            >
              <td className="py-2 pr-3 max-w-[260px]">
                <span className="text-ink line-clamp-1 break-all" title={r.title}>
                  {r.title || '未命名运行'}
                </span>
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <span
                  className={[
                    'text-[10px] px-1.5 py-0.5 rounded font-medium',
                    r.kind === 'board'
                      ? 'bg-primary-tint text-primary'
                      : 'bg-[#10a37f1a] text-done',
                  ].join(' ')}
                >
                  {r.kind === 'board' ? '看板' : '工作台'}
                </span>
              </td>
              <td className="py-2 pr-3 font-mono text-ink-muted whitespace-nowrap">
                {r.model || '—'}
              </td>
              <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                {r.total_tokens != null ? fmtTokens(r.total_tokens) : '—'}
              </td>
              <td className="py-2 pr-3 tabular-nums text-right text-ink-muted whitespace-nowrap">
                {r.duration_ms != null ? fmtDuration(r.duration_ms) : '—'}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <span className={'text-[10px] px-1.5 py-0.5 rounded ' + statusClass(r.status)}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
              </td>
              <td className="py-2 tabular-nums text-right text-ink-dim whitespace-nowrap">
                {fmtDate(r.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
