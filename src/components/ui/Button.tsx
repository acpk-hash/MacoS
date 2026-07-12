// Button — 深色 IDE 按钮：小圆角、细边、扁平，无发光。
// variant: primary(实心强调紫蓝) / ghost / soft / danger。
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'soft'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-btn transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none primary-ring whitespace-nowrap'

const sizes: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-3.5 py-1.5',
}

const variants: Record<Variant, string> = {
  primary:
    'text-white bg-primary hover:bg-primary-hover active:bg-primary-active',
  ghost:
    'text-ink-muted bg-transparent border border-line hover:text-ink hover:bg-surface-2 hover:border-line-strong',
  soft:
    'text-primary bg-primary-tint border border-[#2021233d] hover:bg-[#20212314]',
  danger:
    'text-failed bg-[#d0342c14] border border-[#d0342c40] hover:bg-[#d0342c24]',
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
