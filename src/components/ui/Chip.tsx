// Chip / Tag — 深色 IDE 标签：语义色低透明底 + 语义字 + 细边（无光晕）。
import type { ReactNode } from 'react'

export type ChipTone =
  | 'sakura'
  | 'lavender'
  | 'sky'
  | 'mint'
  | 'gold'
  | 'coral'
  | 'neutral'
  | 'primary'
  | 'running'
  | 'done'
  | 'awaiting'
  | 'failed'
  | 'todo'

// 深色徽章：语义色 10-14% 底 + 语义色文字 + 25% 细边。旧 tone 名映射到语义色。
const tones: Record<ChipTone, string> = {
  primary: 'bg-primary-tint text-primary border-[#8b7cff40]',
  sakura: 'bg-primary-tint text-primary border-[#8b7cff40]',
  lavender: 'bg-primary-tint text-primary border-[#8b7cff40]',
  running: 'bg-[#5b8cff1f] text-running border-[#5b8cff40]',
  sky: 'bg-[#5b8cff1f] text-running border-[#5b8cff40]',
  done: 'bg-[#3fb9501f] text-done border-[#3fb95040]',
  mint: 'bg-[#3fb9501f] text-done border-[#3fb95040]',
  awaiting: 'bg-[#d299221f] text-awaiting border-[#d2992240]',
  gold: 'bg-[#d299221f] text-awaiting border-[#d2992240]',
  failed: 'bg-[#f851491f] text-failed border-[#f8514940]',
  coral: 'bg-[#f851491f] text-failed border-[#f8514940]',
  todo: 'bg-surface-2 text-todo border-line',
  neutral: 'bg-surface-2 text-ink-muted border-line',
}

export interface ChipProps {
  children: ReactNode
  tone?: ChipTone
  className?: string
}

export default function Chip({ children, tone = 'neutral', className = '' }: ChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] leading-none px-2 py-0.5 rounded-chip border font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

export { Chip as Tag }
