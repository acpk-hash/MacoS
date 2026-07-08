// v0.7：二次元吉祥物退场。保留 Mascot 名与 props 签名（避免改动全部空态调用点），
// 渲染为极简线性图标（科研风）：浅灰细描边的圆角文档/占位图标，忽略 mood。
// 建议空态用法：<Mascot size={44} /> + 说明文字。
import type { CSSProperties } from 'react'

export type MascotMood = 'idle' | 'thinking' | 'happy' | 'sad'

interface MascotProps {
  mood?: MascotMood
  size?: number
  className?: string
  /** 兼容旧签名，无效果。 */
  still?: boolean
  title?: string
}

export default function Mascot({
  size = 96,
  className = '',
  title,
}: MascotProps) {
  const style: CSSProperties = { width: size, height: size }
  return (
    <div className={className} style={style} aria-hidden={!title}>
      <svg
        viewBox="0 0 48 48"
        fill="none"
        stroke="#94a3b8"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        role={title ? 'img' : undefined}
        width="100%"
        height="100%"
      >
        {title && <title>{title}</title>}
        {/* 简洁线性「文档/占位」图标 */}
        <rect x="9" y="7" width="30" height="34" rx="4" />
        <line x1="16" y1="16" x2="32" y2="16" />
        <line x1="16" y1="24" x2="32" y2="24" />
        <line x1="16" y1="32" x2="26" y2="32" />
      </svg>
    </div>
  )
}
