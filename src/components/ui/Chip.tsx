// Chip / Tag — 浅蓝底标签。tone 决定语义配色（浅底徽章，非光晕）。
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

// 浅色徽章：极浅底 + 语义文字 + 细边。旧 tone 名映射到 v0.7 语义色。
const tones: Record<ChipTone, string> = {
  primary: 'bg-primary-tint text-primary border-[#c7dbff]',
  running: 'bg-primary-tint text-primary border-[#c7dbff]',
  sakura: 'bg-primary-tint text-primary border-[#c7dbff]',
  lavender: 'bg-primary-tint text-primary border-[#c7dbff]',
  sky: 'bg-primary-tint text-primary border-[#c7dbff]',
  done: 'bg-[#ecfdf5] text-done border-[#bbf7d0]',
  mint: 'bg-[#ecfdf5] text-done border-[#bbf7d0]',
  awaiting: 'bg-[#fffbeb] text-awaiting border-[#fde68a]',
  gold: 'bg-[#fffbeb] text-awaiting border-[#fde68a]',
  failed: 'bg-[#fef2f2] text-failed border-[#fecaca]',
  coral: 'bg-[#fef2f2] text-failed border-[#fecaca]',
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
