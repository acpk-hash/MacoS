// Token 趋势图 — 纯 CSS 堆叠柱状图，不引第三方图表库（自旧 Dashboard 恢复）。

import { useMemo } from 'react'
import { fmtTokens, localDay } from './format'
import type { TokenSeriesPoint } from './types'

export default function TrendChart({ series }: { series: TokenSeriesPoint[] }) {
  // 最近 30 个自然日窗口（含今天）；窗口内完全无数据时回退为最近 30 个有数据的桶。
  const points = useMemo(() => {
    const map = new Map(series.map((p) => [p.date, p]))
    const days: TokenSeriesPoint[] = []
    for (let i = 29; i >= 0; i--) {
      const key = localDay(new Date(Date.now() - i * 86_400_000))
      days.push(map.get(key) ?? { date: key, input: 0, output: 0, total: 0, runs: 0 })
    }
    const hasData = days.some((p) => p.total > 0 || p.runs > 0)
    return hasData ? days : series.slice(-30)
  }, [series])

  const maxTotal = Math.max(1, ...points.map((p) => p.total))

  return (
    <div>
      <div className="h-44 flex items-end gap-[3px]">
        {points.map((p) => {
          const cache = Math.max(0, p.total - p.input - p.output)
          const pct = (n: number) => (n / maxTotal) * 100
          return (
            <div
              key={p.date}
              className="group relative flex-1 h-full flex flex-col justify-end min-w-0"
            >
              {/* hover 提示 */}
              <div
                className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-20
                           bg-elevated border border-line text-ink text-[10.5px] leading-4 rounded-md px-2.5 py-1.5 whitespace-nowrap shadow-lg pointer-events-none"
              >
                <div className="font-medium">{p.date}</div>
                <div className="tabular-nums">
                  合计 {fmtTokens(p.total)} · {p.runs} 轮
                </div>
                <div className="tabular-nums text-ink-muted">
                  输入 {fmtTokens(p.input)} · 输出 {fmtTokens(p.output)}
                  {cache > 0 && <> · 缓存 {fmtTokens(cache)}</>}
                </div>
              </div>
              {/* 柱体：输入(浅蓝) + 输出(深蓝) + 缓存等(极浅蓝)，自下而上 */}
              <div
                className="w-full flex flex-col-reverse rounded-t-[3px] overflow-hidden
                           group-hover:opacity-80 transition-opacity"
                style={{ height: `${Math.min(100, pct(p.total))}%` }}
              >
                <div className="w-full bg-[#8ab4e8]" style={{ flexGrow: p.input }} />
                <div className="w-full bg-[#0d8de3]" style={{ flexGrow: p.output }} />
                <div className="w-full bg-[#d7dee8]" style={{ flexGrow: cache }} />
              </div>
              {/* 无数据日的基线刻度 */}
              {p.total === 0 && <div className="w-full h-[2px] bg-line rounded-full" />}
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-ink-dim tabular-nums">
        <span>{points[0]?.date ?? ''}</span>
        <span>{points[Math.floor(points.length / 2)]?.date ?? ''}</span>
        <span>{points[points.length - 1]?.date ?? ''}</span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[10.5px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <i className="w-2.5 h-2.5 rounded-sm bg-[#8ab4e8] inline-block" />输入
        </span>
        <span className="flex items-center gap-1.5">
          <i className="w-2.5 h-2.5 rounded-sm bg-[#0d8de3] inline-block" />输出
        </span>
        <span className="flex items-center gap-1.5">
          <i className="w-2.5 h-2.5 rounded-sm bg-[#d7dee8] inline-block" />缓存等
        </span>
      </div>
    </div>
  )
}
