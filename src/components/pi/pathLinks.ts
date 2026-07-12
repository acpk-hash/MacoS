// 对话内文件路径 → 可点链接（②）。
//
// 两条通道：
// 1. linkifyPaths(md)：正文里的「裸路径 token」（含扩展名、至少一个路径分隔符，
//    保守匹配）替换为 markdown 链接 [token](#pi-open:<enc>)，交给 MarkdownLite
//    正常渲染；Timeline 在容器上以事件委托拦截点击。
//    代码块/行内代码/既有链接/URL/公式段不做替换。
// 2. looksLikeFilePath(text)：行内代码 <code> 点击时的宽松判定（允许裸文件名、
//    路径中的空格），命中则走 openFileInPanel。
export const PI_OPEN_PREFIX = '#pi-open:'

/** 受保护段：围栏代码 / 行内代码 / markdown 链接 / 裸 URL / 公式。 */
const PROTECTED_RE =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+|\$\$[\s\S]*?\$\$)/g

/**
 * 裸路径 token：可选 盘符/./ ../ ~/ 前缀 + ≥2 个以 / 或 \ 分隔的段 +
 * 扩展名（1–8 位字母数字），后可跟 :行[:列]。
 * 边界故意不含 / 与 \，避免从 URL 中段起匹配。
 */
const PATH_TOKEN_RE =
  /(^|[\s([{<'"「『【（，,：:;=])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])?[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)/g

function linkifySegment(text: string): string {
  return text.replace(PATH_TOKEN_RE, (_m, pre: string, token: string) => {
    return `${pre}[${token}](${PI_OPEN_PREFIX}${encodeURIComponent(token)})`
  })
}

/** 正文 markdown 里的裸路径替换为 #pi-open: 链接（保守，跳过受保护段）。 */
export function linkifyPaths(md: string): string {
  if (!md || !/[\\/]/.test(md)) return md
  const parts = md.split(PROTECTED_RE)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === undefined) continue
    // split(带捕获组) 的奇数下标是受保护段，原样保留。
    out += i % 2 === 1 ? p : linkifySegment(p)
  }
  return out
}

/** 行内代码点击判定：单 token 形似文件路径（允许空格段、裸文件名）。 */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 300 || /\n/.test(t)) return false
  return /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w.\- ]+[\\/])*[\w.\- ]*\w\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(
    t,
  )
}

/** 从 tool 条目 args 里抽文件路径（read/edit/write 等的 path 参数）。 */
export function pathFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  for (const k of ['path', 'file_path', 'filePath']) {
    const v = a[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}
