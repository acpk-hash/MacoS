// Chip / Tag — pastel 全圆标签。tone 决定霓光配色。
import type { ReactNode } from 'react'

export type ChipTone =
  | 'sakura'
  | 'lavender'
  | 'sky'
  | 'mint'
  | 'gold'
  | 'coral'
  | 'neutral'

const tones: Record<ChipTone, string> = {
  sakura: 'bg-sakura/15 text-sakura border-sakura/25',
  lavender: 'bg-lavender/15 text-lavender border-lavender/25',
  sky: 'bg-sky/15 text-sky border-sky/25',
  mint: 'bg-mint/15 text-mint border-mint/25',
  gold: 'bg-gold/15 text-gold border-gold/25',
  coral: 'bg-coral/15 text-coral border-coral/25',
  neutral: 'bg-white/6 text-ink-muted border-line',
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
