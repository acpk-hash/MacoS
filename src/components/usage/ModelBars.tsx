// 按模型占比 — 纯 CSS 横向条形（自旧 Dashboard 恢复）。

import { fmtTokens } from './format'
import type { ModelStat } from './types'

export default function ModelBars({ models }: { models: ModelStat[] }) {
  const totalSum = models.reduce((s, m) => s + m.total, 0)
  const maxRef = totalSum > 0
    ? Math.max(...models.map((m) => m.total))
    : Math.max(1, ...models.map((m) => m.runs))

  if (models.length === 0) {
    return <div className="text-[12px] text-ink-dim">暂无模型使用记录</div>
  }
  return (
    <div className="space-y-2.5">
      {models.map((m) => {
        const value = totalSum > 0 ? m.total : m.runs
        const widthPct = Math.max(2, (value / maxRef) * 100)
        const sharePct = totalSum > 0 ? ((m.total / totalSum) * 100).toFixed(1) : null
        return (
          <div key={m.model || '(空)'}>
            <div className="flex items-baseline gap-2 text-[11.5px] mb-1">
              <span className="font-mono text-ink truncate">
                {m.model || '未记录模型'}
              </span>
              <span className="text-ink-dim tabular-nums flex-shrink-0">
                {m.runs} 次
              </span>
              <span className="ml-auto text-ink-muted font-mono tabular-nums flex-shrink-0">
                {fmtTokens(m.total)}
                {sharePct != null && (
                  <span className="text-ink-dim"> · {sharePct}%</span>
                )}
              </span>
            </div>
            <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#8b7cff] to-[#5b8cff]"
                style={{ width: `${widthPct}%` }}
                title={`输入 ${fmtTokens(m.input)} · 输出 ${fmtTokens(m.output)}`}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
