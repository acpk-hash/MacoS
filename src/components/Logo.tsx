// Iris 品牌标：彩虹女神 Iris 油画方形标（PNG 位图，vite 打包内联/指纹化）。
// 可调尺寸；App 活动栏、状态栏、加载态、about 等处复用。
import logoUrl from '../assets/iris-logo.png'

interface LogoProps {
  size?: number
  /** 小尺寸字形场景（状态栏等），圆角收小保持清晰 */
  glyphOnly?: boolean
  className?: string
}

/**
 * Iris 标志。位图方形 logo，CSS 圆角让它在浅色主题下显得自然；
 * glyphOnly 时同样渲染小图，仅圆角更小以适配 12px 级别的行内场景。
 */
export function Logo({ size = 32, glyphOnly = false, className }: LogoProps) {
  return (
    <img
      src={logoUrl}
      alt="Iris"
      role="img"
      draggable={false}
      style={{ width: size, height: size }}
      className={
        (glyphOnly ? 'rounded-[3px]' : 'rounded-[22%]') +
        ' select-none object-cover shrink-0' +
        (className ? ' ' + className : '')
      }
    />
  )
}

export default Logo
