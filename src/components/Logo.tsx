// AgentBoard 品牌标：欧拉函数 φ(phi)。蓝色圆角方块 + 白色 φ 字形。
// 蓝白科研主题 v0.7 的统一 logo，可调尺寸；App 侧栏、加载态、about 等处复用。

interface LogoProps {
  size?: number
  /** 只要符号（无方块底），用于浅底上的纯字形场景 */
  glyphOnly?: boolean
  className?: string
}

/**
 * 欧拉 φ 标志。方块底用蓝色轻渐变（#2563eb → #3b82f6），φ 为白色圆头竖线穿过椭圆。
 * glyphOnly 时省略方块，φ 用主色描边，适合浅底文字旁。
 */
export function Logo({ size = 32, glyphOnly = false, className }: LogoProps) {
  const stroke = glyphOnly ? '#2563eb' : '#ffffff'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="AgentBoard"
    >
      {!glyphOnly && (
        <>
          <defs>
            <linearGradient id="abLogoGrad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
              <stop stopColor="#2563eb" />
              <stop offset="1" stopColor="#3b82f6" />
            </linearGradient>
          </defs>
          <rect width="40" height="40" rx="9" fill="url(#abLogoGrad)" />
        </>
      )}
      {/* φ：椭圆环 + 贯穿竖线，圆头线条 */}
      <ellipse
        cx="20"
        cy="20"
        rx="7.4"
        ry="9.6"
        stroke={stroke}
        strokeWidth="3"
        fill="none"
      />
      <line
        x1="20"
        y1="7"
        x2="20"
        y2="33"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default Logo
