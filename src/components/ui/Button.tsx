// Button — 蓝白科研主题按钮。variant: primary(实蓝) / ghost / soft / danger。
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'soft'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-btn transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none primary-ring whitespace-nowrap'

const sizes: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-4 py-2',
}

const variants: Record<Variant, string> = {
  primary:
    'text-white bg-primary shadow-card hover:bg-primary-hover',
  ghost:
    'text-ink-muted bg-surface border border-line hover:text-ink hover:bg-surface-2 hover:border-line-strong',
  soft:
    'text-primary bg-primary-tint border border-[#c7dbff] hover:bg-[#e0e9ff]',
  danger:
    'text-failed bg-[#fef2f2] border border-[#fecaca] hover:bg-[#fee2e2]',
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
