// Auto 板块共享的展示格式化工具。
export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

/** 毫秒时长 → "45s" / "3m 12s" / "1h 05m"。 */
export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtDateTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—'
}

/** 相对时间（中文，台账行右侧用）。 */
export function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (secs < 60) return '刚刚'
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`
  if (secs < 86_400) return `${Math.floor(secs / 3600)} 小时前`
  return new Date(ms).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/** 台账按天分组的组标签：今天 / 昨天 / 周几 / 具体日期。 */
export function dayLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return d.toLocaleDateString('zh-CN', { weekday: 'long' })
  return d.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}
