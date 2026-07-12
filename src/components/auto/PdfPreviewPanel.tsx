// Auto 产物检查器里的 PDF 应用内预览(pdfjs 懒加载)。
// 调用 os_read_bytes 读绝对路径 PDF 为 base64,再用 pdfjs 逐页渲染。
import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const MAX_PAGES = 80
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]

function PdfPage({ doc, pageNo, scale }: { doc: PDFDocumentProxy; pageNo: number; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    ;(async () => {
      const page = await doc.getPage(pageNo)
      if (cancelled) return
      const canvas = ref.current
      if (!canvas) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const vp = page.getViewport({ scale })
      canvas.width = Math.floor(vp.width * dpr)
      canvas.height = Math.floor(vp.height * dpr)
      canvas.style.width = Math.floor(vp.width) + 'px'
      canvas.style.height = Math.floor(vp.height) + 'px'
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      await task.promise.catch(() => {})
    })()
    return () => { cancelled = true; task?.cancel() }
  }, [doc, pageNo, scale])
  return <canvas ref={ref} className="shadow-sm border border-line flex-shrink-0" />
}

export default function PdfPreviewPanel({ base64 }: { base64: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageWidth, setPageWidth] = useState(612)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [boxWidth, setBoxWidth] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    setBoxWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    let loaded: PDFDocumentProxy | null = null
    setDoc(null)
    setError(null)
    setZoom('fit')
    ;(async () => {
      try {
        const bin = atob(base64)
        const data = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
        loaded = await pdfjs.getDocument({ data }).promise
        if (!alive) { void loaded.loadingTask.destroy(); return }
        const p1 = await loaded.getPage(1)
        if (!alive) return
        setPageWidth(p1.getViewport({ scale: 1 }).width)
        setDoc(loaded)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => { alive = false; if (loaded) void loaded.loadingTask.destroy() }
  }, [base64])

  const fitScale = Math.min(Math.max((boxWidth - 32) / pageWidth, 0.3), 3)
  const scale = zoom === 'fit' ? fitScale : zoom
  const zoomBy = (dir: 1 | -1) => {
    const cur = scale
    const next = dir === 1
      ? ZOOM_STEPS.find((z) => z > cur * 1.01)
      : [...ZOOM_STEPS].reverse().find((z) => z < cur * 0.99)
    if (next) setZoom(next)
  }
  const numPages = doc?.numPages ?? 0
  const shown = Math.min(numPages, MAX_PAGES)
  const btn = 'px-2 h-6 rounded border border-line text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors'

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line bg-surface/60 shrink-0 select-none">
        <span className="text-[11px] text-ink-dim truncate flex-1">
          {doc ? `共 ${numPages} 页${numPages > MAX_PAGES ? ` (仅渲染前 ${MAX_PAGES} 页)` : ''}` : ''}
        </span>
        <button className={btn} onClick={() => zoomBy(-1)}>-</button>
        <span className="text-[11px] text-ink-muted w-12 text-center font-mono">{Math.round(scale * 100)}%</span>
        <button className={btn} onClick={() => zoomBy(1)}>+</button>
        <button className={[btn, zoom === 'fit' ? 'border-primary/40 text-primary' : ''].join(' ')} onClick={() => setZoom('fit')}>适应宽</button>
      </div>
      <div ref={boxRef} className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="flex items-center justify-center h-full px-6 text-center">
            <p className="text-[12px] text-failed">PDF 加载失败: {error}</p>
          </div>
        ) : !doc ? (
          <div className="flex items-center justify-center h-full text-[12px] text-ink-dim">解析中…</div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4 px-3">
            {Array.from({ length: shown }, (_, i) => (
              <PdfPage key={i} doc={doc} pageNo={i + 1} scale={scale} />
            ))}
            {numPages > MAX_PAGES && (
              <p className="text-[11px] text-ink-dim py-2">-- 已达预览上限 ({MAX_PAGES} 页) --</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
