// 工作台 PDF 预览（Q1）。pdfjs-dist 逐页渲染到 canvas。
//
// - 数据路径：assetProtocol scope 只覆盖 agentboard 自己的 media 目录，
//   工作根是用户任选目录，asset 协议不可用 → 走 ws_read_bytes(base64)
//   → ArrayBuffer → pdfjs.getDocument({ data })。上限 50MB（Rust 侧强制）。
// - worker 离线：vite `?url` 把 pdf.worker.min.mjs 打进本地资源，
//   workerSrc 指向本地 URL，零 CDN 依赖。
// - 本组件经 React.lazy 挂载，pdfjs（~1MB）独立 chunk，不进主 bundle。
import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** 一次最多渲染的页数（防超长 PDF 撑爆内存）。 */
const MAX_RENDER_PAGES = 120

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]

interface WsFileBytes {
  base64: string
  size: number
}

/** 单页：按需取页并渲染到自己的 canvas；scale 变化时重渲。 */
function PdfPage({
  doc,
  pageNo,
  scale,
}: {
  doc: PDFDocumentProxy
  pageNo: number
  scale: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    ;(async () => {
      try {
        const page = await doc.getPage(pageNo)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const vp = page.getViewport({ scale })
        canvas.width = Math.floor(vp.width * dpr)
        canvas.height = Math.floor(vp.height * dpr)
        canvas.style.width = `${Math.floor(vp.width)}px`
        canvas.style.height = `${Math.floor(vp.height)}px`
        task = page.render({
          canvas,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        })
        await task.promise
      } catch {
        /* RenderingCancelledException（切页/缩放打断）— 忽略 */
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNo, scale])
  return <canvas ref={canvasRef} className="bg-white shadow-lg flex-shrink-0" />
}

export default function PdfPreview({ relPath }: { relPath: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageWidth, setPageWidth] = useState(612) // 首页 scale=1 宽度（默认 Letter）
  const [error, setError] = useState<string | null>(null)
  /** 'fit' = 适应宽度；数字 = pdfjs scale 倍率。 */
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [boxWidth, setBoxWidth] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  // 容器宽度跟踪（适应宽度模式）。
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    setBoxWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 加载文档：ws_read_bytes → base64 → ArrayBuffer → pdfjs。
  useEffect(() => {
    let alive = true
    let loaded: PDFDocumentProxy | null = null
    setDoc(null)
    setError(null)
    setZoom('fit')
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<WsFileBytes>('ws_read_bytes', { relPath })
        if (!alive) return
        // 原生 base64 解码（比逐字符 atob 快得多）。
        const buf = await (
          await fetch(`data:application/octet-stream;base64,${res.base64}`)
        ).arrayBuffer()
        if (!alive) return
        loaded = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
        if (!alive) {
          void loaded.loadingTask.destroy()
          return
        }
        const p1 = await loaded.getPage(1)
        if (!alive) return
        setPageWidth(p1.getViewport({ scale: 1 }).width)
        setDoc(loaded)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => {
      alive = false
      if (loaded) void loaded.loadingTask.destroy()
    }
  }, [relPath])

  const fitScale = Math.min(Math.max((boxWidth - 48) / pageWidth, 0.3), 3)
  const scale = zoom === 'fit' ? fitScale : zoom

  const zoomBy = (dir: 1 | -1) => {
    const cur = scale
    const next =
      dir === 1
        ? ZOOM_STEPS.find((z) => z > cur * 1.01)
        : [...ZOOM_STEPS].reverse().find((z) => z < cur * 0.99)
    if (next) setZoom(next)
  }

  const numPages = doc?.numPages ?? 0
  const shownPages = Math.min(numPages, MAX_RENDER_PAGES)

  const btn =
    'px-2 h-6 rounded-btn border border-line text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors'

  return (
    <div className="w-full h-full flex flex-col bg-editor">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line bg-surface/60 flex-shrink-0 select-none">
        <span className="text-[11px] text-ink-dim truncate flex-1">
          {doc
            ? `共 ${numPages} 页${numPages > MAX_RENDER_PAGES ? `（仅渲染前 ${MAX_RENDER_PAGES} 页）` : ''}`
            : ''}
        </span>
        <button className={btn} onClick={() => zoomBy(-1)} title="缩小">
          −
        </button>
        <span className="text-[11px] text-ink-muted w-12 text-center font-mono">
          {Math.round(scale * 100)}%
        </span>
        <button className={btn} onClick={() => zoomBy(1)} title="放大">
          ＋
        </button>
        <button
          className={[btn, zoom === 'fit' ? 'text-lavender border-lavender/40' : ''].join(' ')}
          onClick={() => setZoom('fit')}
          title="适应宽度"
        >
          适应宽
        </button>
      </div>

      {/* 页面区 */}
      <div ref={boxRef} className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-2xl">📄</div>
            <p className="text-[12px] text-coral">PDF 加载失败：{error}</p>
          </div>
        ) : !doc ? (
          <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
            PDF 解析中…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4 px-3">
            {Array.from({ length: shownPages }, (_, i) => (
              <PdfPage key={`${relPath}:${i + 1}`} doc={doc} pageNo={i + 1} scale={scale} />
            ))}
            {numPages > MAX_RENDER_PAGES && (
              <p className="text-[11px] text-ink-dim py-2">
                — 已达预览页数上限（{MAX_RENDER_PAGES} 页），完整内容请用外部阅读器打开 —
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
