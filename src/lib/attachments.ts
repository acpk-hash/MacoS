import type { Attachment } from '../stores/studioStore'

// ── Attachment constraints ────────────────────────────────────────────────────

/** Max decoded size of a single attachment (after image compression). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024 // 10MB
/** Max size for an inlined text-file attachment. */
export const MAX_TEXT_BYTES = 200 * 1024 // 200KB
/** Total budget across all inlined text attachments in one message. */
export const MAX_TOTAL_TEXT_BYTES = 600 * 1024 // 600KB
/** Longest edge (px) an image is downscaled to before sending. */
export const MAX_IMAGE_EDGE = 2048

// ── Low-level readers ─────────────────────────────────────────────────────────

export function readAsDataURL(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

/** Approximate decoded byte size of a data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor((b64.length * 3) / 4)
}

/** Compress an image to <= MAX_IMAGE_EDGE on its longest side, as a data URL. */
export async function compressImage(file: File | Blob): Promise<string> {
  const original = await readAsDataURL(file)
  let img: HTMLImageElement
  try {
    img = await loadImage(original)
  } catch {
    return original
  }
  let { width, height } = img
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
  if (scale >= 1) {
    // No resize needed; keep original unless it needs re-encode for size.
    return original
  }
  width = Math.round(width * scale)
  height = Math.round(height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return original
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.9)
}

/** Safely parse a stored `attachments_json` string into an Attachment[]. */
export function parseAttachments(json: string | null): Attachment[] {
  if (!json) return []
  try {
    return JSON.parse(json) as Attachment[]
  } catch {
    return []
  }
}

// ── File classification（拖任意文件：图片 / 文本类 / 其他） ─────────────────────

/** Extensions treated as inlineable text (code / config / logs / data). */
const TEXT_EXT_RE =
  /\.(txt|md|markdown|rst|adoc|json|jsonl|ndjson|csv|tsv|log|xml|svg|html|htm|css|scss|less|js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|ipynb|rb|php|java|c|h|cpp|hpp|cc|hh|cs|go|rs|swift|kt|kts|scala|lua|pl|pm|r|mm|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|yaml|yml|toml|ini|cfg|conf|env|properties|gradle|cmake|tex|bib|diff|patch|lock|editorconfig|gitignore|gitattributes|dockerignore|npmrc|nvmrc|prettierrc|eslintrc)$/i

/** Extension-less names that are conventionally text. */
const TEXT_NAME_RE = /^(dockerfile|makefile|license|readme|changelog|\.env(\..+)?)$/i

/** Whether a dropped/picked file should be read as inline text. */
export function isTextLikeFile(file: File): boolean {
  const t = file.type
  if (t.startsWith('text/')) return true
  if (/(json|xml|yaml|toml|csv|javascript|ecmascript|x-sh|x-python)/i.test(t)) return true
  return TEXT_EXT_RE.test(file.name) || TEXT_NAME_RE.test(file.name)
}

/** Fatal-decode `buf` with `encoding`, allowing up to `maxTrailCut` trailing
 *  bytes to be dropped (a truncated read may split a multi-byte character). */
function tryDecode(buf: Uint8Array, encoding: string, maxTrailCut: number): string | null {
  for (let cut = 0; cut <= maxTrailCut; cut++) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(
        buf.subarray(0, buf.length - cut),
      )
    } catch {
      /* try a shorter tail */
    }
  }
  return null
}

export type SmartTextResult = { text: string; truncated: boolean } | { error: string }

/**
 * Read a file as text. Reads at most the first MAX_TEXT_BYTES; decoding tries
 * UTF-8 first, then GBK (中文本地文件常见编码). NUL bytes / undecodable
 * content → error（按二进制处理）.
 */
export async function readTextSmart(file: File): Promise<SmartTextResult> {
  const truncated = file.size > MAX_TEXT_BYTES
  const blob = truncated ? file.slice(0, MAX_TEXT_BYTES) : file
  let buf: Uint8Array
  try {
    buf = new Uint8Array(await blob.arrayBuffer())
  } catch {
    return { error: '读取失败' }
  }
  if (buf.includes(0)) return { error: '二进制文件' }
  const text =
    tryDecode(buf, 'utf-8', truncated ? 3 : 0) ?? tryDecode(buf, 'gbk', truncated ? 1 : 0)
  if (text == null) return { error: '编码无法识别' }
  return { text, truncated }
}

/** UTF-8 byte length of a JS string. */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Sum of inlined text bytes already held in `atts` (for the total budget). */
export function attachmentsTextBytes(atts: Attachment[]): number {
  let n = 0
  for (const a of atts) {
    if (a.kind === 'text' && a.text) n += utf8Len(a.text)
  }
  return n
}

export interface FilesIngestResult {
  attachments: Attachment[]
  /** 用户可读的跳过/截断提示（每项一条）。 */
  warnings: string[]
}

/**
 * Turn dropped / picked files into attachments:
 * - images → compressed data-URL attachment;
 * - text-like files → inlined text（≤200KB/文件，截断加标注；共享总量上限）;
 * - anything else（二进制/超大/编码不明）→ skipped with a warning.
 */
export async function filesToAttachments(
  files: File[],
  existingTextBytes = 0,
): Promise<FilesIngestResult> {
  const attachments: Attachment[] = []
  const warnings: string[] = []
  let used = existingTextBytes
  for (const file of files) {
    const name = file.name || '文件'
    if (file.type.startsWith('image/')) {
      try {
        const dataUrl = await compressImage(file)
        if (dataUrlBytes(dataUrl) > MAX_ATTACH_BYTES) {
          warnings.push(`「${name}」图片超过 10MB，已跳过`)
          continue
        }
        attachments.push({ kind: 'image', name, data_url: dataUrl })
      } catch {
        warnings.push(`「${name}」图片处理失败`)
      }
      continue
    }
    if (!isTextLikeFile(file)) {
      warnings.push(`「${name}」暂不支持该类型，已跳过`)
      continue
    }
    const res = await readTextSmart(file)
    if ('error' in res) {
      warnings.push(`「${name}」${res.error}，已跳过`)
      continue
    }
    const size = utf8Len(res.text)
    if (used + size > MAX_TOTAL_TEXT_BYTES) {
      warnings.push(
        `「${name}」附件总量超出 ${Math.round(MAX_TOTAL_TEXT_BYTES / 1024)}KB 上限，已跳过`,
      )
      continue
    }
    used += size
    if (res.truncated) warnings.push(`「${name}」超过 200KB，已截断`)
    attachments.push({
      kind: 'text',
      name,
      text: res.truncated ? res.text + '\n\n……（文件过长，已截取前 200KB）' : res.text,
    })
  }
  return { attachments, warnings }
}
