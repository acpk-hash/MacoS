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
  primary: 'bg-primary-tint text-primary border-[#2021233d]',
  sakura: 'bg-primary-tint text-primary border-[#2021233d]',
  lavender: 'bg-primary-tint text-primary border-[#2021233d]',
  running: 'bg-[#0d8de31a] text-running border-[#0d8de340]',
  sky: 'bg-[#0d8de31a] text-running border-[#0d8de340]',
  done: 'bg-[#10a37f1a] text-done border-[#10a37f40]',
  mint: 'bg-[#10a37f1a] text-done border-[#10a37f40]',
  awaiting: 'bg-[#b7791f1a] text-awaiting border-[#b7791f40]',
  gold: 'bg-[#b7791f1a] text-awaiting border-[#b7791f40]',
  failed: 'bg-[#d0342c1a] text-failed border-[#d0342c40]',
  coral: 'bg-[#d0342c1a] text-failed border-[#d0342c40]',
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
