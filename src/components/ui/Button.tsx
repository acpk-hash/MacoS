// Button — 二次元主题按钮。variant: primary(渐变发光) / ghost / danger / soft。
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'soft'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-btn transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none whitespace-nowrap'

const sizes: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-4 py-2',
}

const variants: Record<Variant, string> = {
  primary:
    'text-white bg-grad-primary shadow-glow-primary hover:-translate-y-px hover:shadow-[0_6px_26px_rgba(255,127,191,0.4)]',
  ghost:
    'text-ink-muted bg-white/5 border border-line hover:text-ink hover:bg-white/10 hover:border-line-strong',
  soft:
    'text-lavender bg-lavender/15 border border-lavender/25 hover:bg-lavender/25 hover:text-ink',
  danger:
    'text-coral bg-coral/12 border border-coral/25 hover:bg-coral/25 hover:text-white',
}

export default function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
