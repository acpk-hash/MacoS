// AgentHub 共用小工具：时间显示 / 按天分组 / 工具统计 / 状态样式 / 剪贴板。
import type {
  WorkflowRecord,
  WorkflowStatus,
  WorkflowStep,
} from '../../stores/agentHubStore'

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayLabel(ts: number): string {
  const today = dayStart(Date.now())
  const day = dayStart(ts)
  if (day === today) return '今天'
  if (day === today - 86_400_000) return '昨天'
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** 记录已按最近存档时间降序（store 保证最新在前），顺序切组即可。 */
export function groupByDay(
  records: WorkflowRecord[],
): Array<{ label: string; items: WorkflowRecord[] }> {
  const groups: Array<{ label: string; items: WorkflowRecord[] }> = []
  for (const r of records) {
    const label = dayLabel(r.finishedAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(r)
    else groups.push({ label, items: [r] })
  }
  return groups
}

/** 工具调用统计（bash×3 edit×2 …），按次数降序。 */
export function toolCounts(
  steps: WorkflowStep[],
): Array<{ name: string; count: number }> {
  const m = new Map<string, number>()
  for (const s of steps) {
    if (s.kind !== 'tool') continue
    const name = (s.toolName ?? 'tool').toLowerCase()
    m.set(name, (m.get(name) ?? 0) + 1)
  }
  return Array.from(m, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count,
  )
}

export const STATUS_META: Record<WorkflowStatus, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'text-done bg-done/10 border-done/30' },
  error: { label: '出错', cls: 'text-coral bg-coral/10 border-coral/30' },
  running: { label: '进行中', cls: 'text-sky bg-sky/10 border-sky/30' },
}

/** 剪贴板写入（Clipboard API + execCommand 兜底）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
