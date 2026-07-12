// 跨境电商板块共享 UI 小件：可信度标签 / 表单原子 / Markdown 导出。
import type { ReactNode } from 'react'

// ── 可信度标签（三种来源在每个模块顶部明示） ─────────────────────────────────

export type TrustKind = 'ai' | 'local' | 'user'

const TRUST_STYLE: Record<TrustKind, { label: string; cls: string }> = {
  ai: { label: 'AI 分析辅助', cls: 'bg-lavender/10 text-lavender border-lavender/30' },
  local: { label: '本地硬计算', cls: 'bg-mint/10 text-mint border-mint/30' },
  user: { label: '用户真实数据', cls: 'bg-sky/10 text-sky border-sky/30' },
}

export function TrustBadge({ kind }: { kind: TrustKind }) {
  const t = TRUST_STYLE[kind]
  return (
    <span
      className={
        'inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-medium leading-4 ' +
        t.cls
      }
    >
      {t.label}
    </span>
  )
}

// ── 表单原子（统一样式） ─────────────────────────────────────────────────────

export const inputCls =
  'w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors'

export const selectCls =
  'bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors disabled:opacity-50'

export const btnPrimaryCls =
  'px-4 py-2 rounded-lg text-sm font-medium bg-grad-primary text-white shadow-glow-primary hover:-translate-y-px disabled:opacity-40 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all'

export const btnGhostCls =
  'px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-line text-ink-muted hover:bg-elevated hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-ink-dim tracking-wide">
        {label}
        {hint && <span className="ml-2 font-normal text-ink-faint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function SectionCard({
  title,
  badge,
  actions,
  children,
}: {
  title: string
  badge?: TrustKind
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {badge && <TrustBadge kind={badge} />}
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      {children}
    </section>
  )
}

// ── 导出 / 复制 ──────────────────────────────────────────────────────────────

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 从模型回复剥掉可能包裹的 ``` 围栏。 */
export function stripFence(text: string): string {
  const t = (text ?? '').trim()
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)```\s*$/i.exec(t)
  return m ? m[1].trim() : t
}
