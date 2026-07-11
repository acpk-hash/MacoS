// AgentBoard 品牌标：欧拉函数 φ(phi)。深色 IDE 主题下配色贴 accent 紫蓝：
// 方块底用签名渐变（#8b7cff → #5b8cff），φ 为白色圆头竖线穿过椭圆。
// 可调尺寸；App 活动栏、加载态、about 等处复用。

interface LogoProps {
  size?: number
  /** 只要符号（无方块底），用于深底上的纯字形场景 */
  glyphOnly?: boolean
  className?: string
}

/**
 * 欧拉 φ 标志。方块底用紫蓝签名渐变（品牌点，全站极少数允许渐变处）。
 * glyphOnly 时省略方块，φ 用 accent 紫描边，适合深底文字旁。
 */
export function Logo({ size = 32, glyphOnly = false, className }: LogoProps) {
  const stroke = glyphOnly ? '#8b7cff' : '#ffffff'
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
              <stop stopColor="#8b7cff" />
              <stop offset="1" stopColor="#5b8cff" />
            </linearGradient>
          </defs>
          <rect width="40" height="40" rx="8" fill="url(#abLogoGrad)" />
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
