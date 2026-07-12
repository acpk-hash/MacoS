// 工作台图片预览（Q1）。图片是二进制且工作根是任意目录（不在 assetProtocol
// scope 内），故走 ws_read_bytes 拿 base64 → data URL 显示。
// 支持 适应窗口 / 实际大小 / 逐级缩放；透明图垫深色棋盘格。
// 仅本地工作区可用（远程 SFTP 由 EditorPane 提前拦截为占位）。
import { useEffect, useRef, useState } from 'react'

/** 可用 <img> 直接预览的扩展名 → MIME。 */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

interface WsFileBytes {
  base64: string
  size: number
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]

/** 透明底棋盘格（深色，配 Trae 主题）。 */
const CHECKER: React.CSSProperties = {
  background: 'repeating-conic-gradient(#26262c 0% 25%, #1e1e22 0% 50%) 0 0 / 16px 16px',
}

export default function ImagePreview({ relPath, ext }: { relPath: string; ext: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  const [dims, setDims] = useState<[number, number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 'fit' = 适应窗口；数字 = 相对原始尺寸的倍率。 */
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setUrl(null)
    setError(null)
    setDims(null)
    setZoom('fit')
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<WsFileBytes>('ws_read_bytes', { relPath })
        if (!alive) return
        const mime = IMAGE_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
        setUrl(`data:${mime};base64,${res.base64}`)
        setSize(res.size)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [relPath, ext])

  /** 当前有效倍率：fit 时按容器实测算（只缩不放，最大 1）。 */
  const effZoom = (): number => {
    if (zoom !== 'fit') return zoom
    const box = boxRef.current
    if (!box || !dims) return 1
    const fw = (box.clientWidth - 32) / dims[0]
    const fh = (box.clientHeight - 32) / dims[1]
    return Math.min(fw, fh, 1)
  }

  const zoomBy = (dir: 1 | -1) => {
    const cur = effZoom()
    const next =
      dir === 1
        ? ZOOM_STEPS.find((z) => z > cur * 1.01)
        : [...ZOOM_STEPS].reverse().find((z) => z < cur * 0.99)
    if (next) setZoom(next)
  }

  const btn =
    'px-2 h-6 rounded-btn border border-line text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors'

  return (
    <div className="w-full h-full flex flex-col bg-editor">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line bg-surface/60 flex-shrink-0 select-none">
        <span className="text-[11px] text-ink-dim truncate flex-1">
          {dims ? `${dims[0]} × ${dims[1]} px` : ''}
          {size > 0 ? `　${fmtSize(size)}` : ''}
        </span>
        <button className={btn} onClick={() => zoomBy(-1)} title="缩小">
          −
        </button>
        <span className="text-[11px] text-ink-muted w-12 text-center font-mono">
          {zoom === 'fit' ? '适应' : `${Math.round(zoom * 100)}%`}
        </span>
        <button className={btn} onClick={() => zoomBy(1)} title="放大">
          ＋
        </button>
        <button
          className={[btn, zoom === 'fit' ? 'text-lavender border-lavender/40' : ''].join(' ')}
          onClick={() => setZoom('fit')}
          title="适应窗口"
        >
          适应
        </button>
        <button
          className={[btn, zoom === 1 ? 'text-lavender border-lavender/40' : ''].join(' ')}
          onClick={() => setZoom(1)}
          title="实际大小（100%）"
        >
          1:1
        </button>
      </div>

      {/* 图片区 */}
      <div ref={boxRef} className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-2xl">🖼️</div>
            <p className="text-[12px] text-coral">图片加载失败：{error}</p>
          </div>
        ) : !url ? (
          <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
            图片加载中…
          </div>
        ) : zoom === 'fit' ? (
          <div className="w-full h-full flex items-center justify-center p-4">
            <img
              src={url}
              alt={relPath}
              onLoad={(e) =>
                setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])
              }
              className="max-w-full max-h-full object-contain"
              style={CHECKER}
            />
          </div>
        ) : (
          <div className="min-w-full min-h-full inline-flex items-start justify-center p-4">
            <img
              src={url}
              alt={relPath}
              onLoad={(e) =>
                setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])
              }
              className="max-w-none flex-shrink-0"
              style={{
                ...CHECKER,
                width: dims ? `${Math.max(1, Math.round(dims[0] * zoom))}px` : undefined,
                imageRendering: zoom > 1 ? 'pixelated' : 'auto',
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
