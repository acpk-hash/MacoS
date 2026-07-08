// Card / Panel — 蓝白科研容器：白底 + 细描边 + 柔和阴影（非玻璃霓光）。
import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /** 悬浮上浮 + 加深阴影（可点击卡片用）。 */
  hover?: boolean
}

export function Card({ children, hover = false, className = '', ...rest }: CardProps) {
  return (
    <div
      className={[
        'bg-surface border border-line rounded-card shadow-card',
        hover
          ? 'transition-all duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop'
          : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

/** GlassPanel — 悬浮层/弹层：白底 + 强阴影。 */
export function GlassPanel({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`bg-elevated border border-line rounded-pop shadow-pop ${className}`} {...rest}>
      {children}
    </div>
  )
}

export default Card
