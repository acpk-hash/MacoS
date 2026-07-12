// 画廊筛选条：按模型 / 时间 / 关键词 / 收藏 实时过滤历史生成记录。

export type TimeRange = 'all' | 'today' | '7d' | '30d'

const TIME_TABS: { key: TimeRange; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'all', label: '全部' },
]

/** 计算某时间档的起始时间戳（毫秒）；'all' 返回 0。 */
export function rangeStart(range: TimeRange, now: number): number {
  switch (range) {
    case 'today': {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    case '7d':
      return now - 7 * 86_400_000
    case '30d':
      return now - 30 * 86_400_000
    case 'all':
      return 0
  }
}

export interface FilterBarProps {
  /** 历史记录中出现过的模型（去重）。 */
  models: string[]
  model: string
  onModel: (v: string) => void
  range: TimeRange
  onRange: (v: TimeRange) => void
  keyword: string
  onKeyword: (v: string) => void
  favOnly: boolean
  onFavOnly: (v: boolean) => void
  /** 筛选后 / 总数，用于统计显示。 */
  shown: number
  total: number
  hasActive: boolean
  onClear: () => void
}

export default function FilterBar({
  models,
  model,
  onModel,
  range,
  onRange,
  keyword,
  onKeyword,
  favOnly,
  onFavOnly,
  shown,
  total,
  hasActive,
  onClear,
}: FilterBarProps) {
  const ctlCls =
    'bg-surface border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors'
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-line flex-shrink-0">
      {/* 关键词 */}
      <input
        type="search"
        value={keyword}
        onChange={(e) => onKeyword(e.target.value)}
        placeholder="搜索提示词…"
        className={ctlCls + ' w-48 placeholder-ink-dim'}
      />

      {/* 模型 */}
      <select
        value={model}
        onChange={(e) => onModel(e.target.value)}
        className={ctlCls + ' max-w-[180px]'}
        title="按模型筛选"
      >
        <option value="">全部模型</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      {/* 时间 */}
      <div className="inline-flex p-0.5 rounded-lg bg-surface-2 border border-line">
        {TIME_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onRange(t.key)}
            className={[
              'px-2.5 py-1 rounded-md text-xs transition-colors',
              range === t.key
                ? 'bg-sakura text-white font-medium'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 收藏 */}
      <button
        onClick={() => onFavOnly(!favOnly)}
        className={[
          'px-2.5 py-1.5 rounded-lg text-xs border transition-colors',
          favOnly
            ? 'bg-gold/15 border-gold/60 text-gold font-medium'
            : 'bg-surface border-line text-ink-muted hover:text-ink hover:border-line-strong',
        ].join(' ')}
        title="只看收藏"
      >
        {favOnly ? '★' : '☆'} 收藏
      </button>

      <div className="flex-1" />

      {/* 统计 + 清除 */}
      <span className="text-[11px] text-ink-dim">
        {hasActive ? `${shown} / ${total} 张` : `共 ${total} 张`}
      </span>
      {hasActive && (
        <button
          onClick={onClear}
          className="text-[11px] text-ink-muted hover:text-ink px-2 py-1 rounded-md hover:bg-surface-2 transition-colors"
        >
          清除筛选
        </button>
      )}
    </div>
  )
}
