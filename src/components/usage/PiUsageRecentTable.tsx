// 最近用量记录 — pi_usage 表的原始行（每行 = 一条 assistant 回复的计量）。

import { fmtCost, fmtDate, fmtTokens } from './format'
import type { PiUsageRecord } from './types'

export default function PiUsageRecentTable({ records }: { records: PiUsageRecord[] }) {
  if (records.length === 0) {
    return <div className="text-[12px] text-ink-dim">暂无用量记录</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] text-ink-dim border-b border-line">
            <th className="py-2 pr-3 font-medium">时间</th>
            <th className="py-2 pr-3 font-medium">模型</th>
            <th className="py-2 pr-3 font-medium">服务商</th>
            <th className="py-2 pr-3 font-medium text-right">输入</th>
            <th className="py-2 pr-3 font-medium text-right">输出</th>
            <th className="py-2 pr-3 font-medium text-right">缓存读</th>
            <th className="py-2 pr-3 font-medium text-right">缓存写</th>
            <th className="py-2 font-medium text-right">费用</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={r.id}
              className="border-b border-line/60 hover:bg-surface/60 transition-colors"
            >
              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap tabular-nums">
                {fmtDate(r.ts)}
              </td>
              <td className="py-2 pr-3 font-mono text-ink whitespace-nowrap">
                {r.model || '—'}
              </td>
              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">
                {r.provider || '—'}
              </td>
              <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                {fmtTokens(r.input)}
              </td>
              <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                {fmtTokens(r.output)}
              </td>
              <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink-muted whitespace-nowrap">
                {fmtTokens(r.cache_read)}
              </td>
              <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink-muted whitespace-nowrap">
                {fmtTokens(r.cache_write)}
              </td>
              <td className="py-2 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                {fmtCost(r.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
