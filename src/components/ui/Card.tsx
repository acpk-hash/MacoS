// Card / Panel — 深色 IDE 容器：面板底 + 1px 细边分层（阴影几乎不用）。
import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /** 悬浮加深边框/底色（可点击卡片用），不上浮不发光。 */
  hover?: boolean
}

export function Card({ children, hover = false, className = '', ...rest }: CardProps) {
  return (
    <div
      className={[
        'bg-surface border border-line rounded-card',
        hover
          ? 'transition-colors duration-150 hover:border-line-strong hover:bg-elevated'
          : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

/** GlassPanel — 悬浮层/弹层：elevated 底 + 细边 + 深投影。 */
export function GlassPanel({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`bg-elevated border border-line rounded-pop shadow-pop ${className}`} {...rest}>
      {children}
    </div>
  )
}

export default Card
