import type { Attachment } from '../stores/studioStore'

// ── Attachment constraints ────────────────────────────────────────────────────

/** Max decoded size of a single attachment (after image compression). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024 // 10MB
/** Max size for an inlined text-file attachment. */
export const MAX_TEXT_BYTES = 200 * 1024 // 200KB
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
