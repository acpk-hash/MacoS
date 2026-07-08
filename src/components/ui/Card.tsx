// Card / GlassPanel — 玻璃拟态容器。
import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /** 悬浮上浮 + 加深光晕（可点击卡片用）。 */
  hover?: boolean
}

export function Card({ children, hover = false, className = '', ...rest }: CardProps) {
  return (
    <div
      className={[
        'glass rounded-card',
        hover
          ? 'transition-all duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-glass'
          : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

/** GlassPanel — 更强的玻璃层，用于弹层/侧栏/大面板。 */
export function GlassPanel({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`glass-strong rounded-pop ${className}`} {...rest}>
      {children}
    </div>
  )
}

export default Card
