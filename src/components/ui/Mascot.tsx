// Mascot（星灵小机器人）— 二次元吉祥物，用于空态/加载/logo 旁。
// 圆脑袋 + 大眼 + 头顶星芒，粉蓝配色。mood 控制表情与微动效。
import type { CSSProperties } from 'react'

export type MascotMood = 'idle' | 'thinking' | 'happy' | 'sad'

interface MascotProps {
  mood?: MascotMood
  size?: number
  className?: string
  /** 关闭浮动/思考微动效（例如 logo 位置）。 */
  still?: boolean
  title?: string
}

export default function Mascot({
  mood = 'idle',
  size = 96,
  className = '',
  still = false,
  title,
}: MascotProps) {
  const floatCls = still || mood === 'sad' ? '' : 'animate-float-soft'
  const style: CSSProperties = { width: size, height: size }

  return (
    <div className={`${floatCls} ${className}`} style={style} aria-hidden={!title}>
      <svg viewBox="0 0 120 120" fill="none" role={title ? 'img' : undefined}>
        {title && <title>{title}</title>}
        <defs>
          <linearGradient id="mascotBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ff7fbf" />
            <stop offset="50%" stopColor="#b58fff" />
            <stop offset="100%" stopColor="#7fb0ff" />
          </linearGradient>
          <linearGradient id="mascotStar" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd88f" />
            <stop offset="100%" stopColor="#ff7fbf" />
          </linearGradient>
          <radialGradient id="mascotGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#b58fff" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#b58fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* 弥散光晕 */}
        <circle cx="60" cy="64" r="46" fill="url(#mascotGlow)" />

        {/* 头顶星芒 */}
        <path
          d="M60 8 L64 20 L76 22 L66 30 L69 42 L60 35 L51 42 L54 30 L44 22 L56 20 Z"
          fill="url(#mascotStar)"
          className={mood === 'thinking' ? 'animate-pulse' : ''}
        />
        {/* 天线 */}
        <line x1="60" y1="34" x2="60" y2="44" stroke="#b58fff" strokeWidth="3" strokeLinecap="round" />

        {/* 脑袋 */}
        <rect x="26" y="44" width="68" height="58" rx="26" fill="url(#mascotBody)" />
        {/* 顶部内高光 */}
        <rect x="30" y="48" width="60" height="20" rx="16" fill="#ffffff" opacity="0.12" />

        {/* 脸屏 */}
        <rect x="36" y="56" width="48" height="36" rx="16" fill="#1e1b2e" />

        {/* 眼睛 —— 按 mood 变化 */}
        {mood === 'happy' ? (
          <>
            <path d="M46 76 q5 -7 10 0" stroke="#7fe7c4" strokeWidth="3.5" strokeLinecap="round" fill="none" />
            <path d="M64 76 q5 -7 10 0" stroke="#7fe7c4" strokeWidth="3.5" strokeLinecap="round" fill="none" />
          </>
        ) : mood === 'sad' ? (
          <>
            <circle cx="51" cy="75" r="4.5" fill="#7fb0ff" />
            <circle cx="69" cy="75" r="4.5" fill="#7fb0ff" />
            <path d="M50 86 q10 -6 20 0" stroke="#7fb0ff" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.7" />
          </>
        ) : mood === 'thinking' ? (
          <>
            <circle cx="51" cy="74" r="5" fill="#ffd88f" className="animate-pulse" />
            <circle cx="69" cy="74" r="5" fill="#ffd88f" className="animate-pulse" />
            <circle cx="53" cy="72" r="1.6" fill="#fff" />
            <circle cx="71" cy="72" r="1.6" fill="#fff" />
          </>
        ) : (
          <>
            <circle cx="51" cy="74" r="5.5" fill="#ff7fbf" />
            <circle cx="69" cy="74" r="5.5" fill="#ff7fbf" />
            <circle cx="53" cy="72" r="1.8" fill="#fff" />
            <circle cx="71" cy="72" r="1.8" fill="#fff" />
          </>
        )}

        {/* 腮红 */}
        <circle cx="41" cy="84" r="3.5" fill="#ff7fbf" opacity="0.5" />
        <circle cx="79" cy="84" r="3.5" fill="#ff7fbf" opacity="0.5" />

        {/* 侧耳 */}
        <circle cx="24" cy="73" r="6" fill="url(#mascotBody)" />
        <circle cx="96" cy="73" r="6" fill="url(#mascotBody)" />
      </svg>
    </div>
  )
}
