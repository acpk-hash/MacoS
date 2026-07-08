import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { GenMediaRow } from '../stores/studioStore'

type Tool = 'select' | 'rect' | 'arrow' | 'brush' | 'text'

interface Point {
  x: number
  y: number
}

type Op =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'text'; x: number; y: number; text: string; color: string }
  | { kind: 'brush'; points: Point[]; size: number }

interface DraftShape {
  tool: 'rect' | 'arrow'
  start: Point
  end: Point
  color: string
}

const COLORS = ['#ef4444', '#f59e0b', '#84cc16', '#3b82f6', '#ffffff', '#111827']

const DEFAULT_GUIDE =
  '请描述你想对标注区域做的修改，例如：把红框里的物体替换为……／让涂抹区域变成……'

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineW: number,
  color: string,
): void {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lineW
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const head = Math.max(lineW * 3.5, 14)
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7))
  ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7))
  ctx.closePath()
  ctx.fill()
}

function drawBrushPath(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  size: number,
  stroke: string,
): void {
  if (points.length === 0) return
  ctx.strokeStyle = stroke
  ctx.fillStyle = stroke
  ctx.lineWidth = size
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  ctx.stroke()
}

export default function ImageAnnotator({
  row,
  model,
  onClose,
  onSubmit,
  busy = false,
}: {
  row: GenMediaRow
  model: string
  onClose: () => void
  onSubmit: (args: {
    prompt: string
    maskDataUrl: string | null
    annotatedDataUrl: string
  }) => void
  busy?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgReady, setImgReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState<string>(COLORS[0])
  const [brushSize, setBrushSize] = useState<number>(28)
  const [ops, setOps] = useState<Op[]>([])
  const [draft, setDraft] = useState<DraftShape | null>(null)
  const [liveBrush, setLiveBrush] = useState<Point[] | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [prompt, setPrompt] = useState('')

  const drawingRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load the source image as a same-origin blob to keep the canvas untainted
  // (so toDataURL works even for the Tauri asset protocol).
  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    const src = row.local_path ? convertFileSrc(row.local_path) : ''
    if (!src) {
      setLoadError('原图路径缺失')
      return
    }
    const loadFrom = (url: string) => {
      const im = new Image()
      im.onload = () => {
        if (cancelled) return
        imgRef.current = im
        setImgReady(true)
      }
      im.onerror = () => {
        if (!cancelled) setLoadError('原图加载失败')
      }
      im.src = url
    }
    fetch(src)
      .then((r) => r.blob())
      .then((b) => {
        if (cancelled) return
        revoked = URL.createObjectURL(b)
        loadFrom(revoked)
      })
      .catch(() => {
        if (!cancelled) loadFrom(src)
      })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [row.local_path])

  useEffect(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!imgReady || !img || !canvas) return
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
  }, [imgReady])

  const lineWidth = imgRef.current
    ? Math.max(2, Math.round(imgRef.current.naturalWidth / 320))
    : 3

  useEffect(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!imgReady || !img || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    const font = Math.max(16, Math.round(canvas.width / 28))
    for (const op of ops) {
      if (op.kind === 'rect') {
        ctx.strokeStyle = op.color
        ctx.lineWidth = lineWidth
        ctx.strokeRect(op.x, op.y, op.w, op.h)
      } else if (op.kind === 'arrow') {
        drawArrow(ctx, op.x1, op.y1, op.x2, op.y2, lineWidth, op.color)
      } else if (op.kind === 'text') {
        ctx.font = `bold ${font}px sans-serif`
        ctx.textBaseline = 'top'
        ctx.lineWidth = Math.max(2, font / 8)
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'
        ctx.strokeText(op.text, op.x, op.y)
        ctx.fillStyle = op.color
        ctx.fillText(op.text, op.x, op.y)
      } else {
        drawBrushPath(ctx, op.points, op.size, 'rgba(236,72,153,0.5)')
      }
    }

    if (draft) {
      if (draft.tool === 'rect') {
        ctx.strokeStyle = draft.color
        ctx.lineWidth = lineWidth
        ctx.strokeRect(
          draft.start.x,
          draft.start.y,
          draft.end.x - draft.start.x,
          draft.end.y - draft.start.y,
        )
      } else {
        drawArrow(ctx, draft.start.x, draft.start.y, draft.end.x, draft.end.y, lineWidth, draft.color)
      }
    }
    if (liveBrush) drawBrushPath(ctx, liveBrush, brushSize, 'rgba(236,72,153,0.5)')
  }, [imgReady, ops, draft, liveBrush, lineWidth, brushSize])

  const toPoint = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imgReady) return
    const p = toPoint(e)
    if (tool === 'select') return
    if (tool === 'text') {
      const text = window.prompt('文字标签内容')
      if (text && text.trim()) {
        setOps((o) => [...o, { kind: 'text', x: p.x, y: p.y, text: text.trim(), color }])
      }
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    drawingRef.current = true
    if (tool === 'brush') {
      setLiveBrush([p])
    } else {
      setDraft({ tool, start: p, end: p, color })
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    const p = toPoint(e)
    if (tool === 'brush') {
      setLiveBrush((pts) => (pts ? [...pts, p] : [p]))
    } else {
      setDraft((d) => (d ? { ...d, end: p } : d))
    }
  }

  const onPointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (tool === 'brush') {
      setLiveBrush((pts) => {
        if (pts && pts.length > 0) {
          setOps((o) => [...o, { kind: 'brush', points: pts, size: brushSize }])
        }
        return null
      })
    } else {
      setDraft((d) => {
        if (d) {
          const dw = Math.abs(d.end.x - d.start.x)
          const dh = Math.abs(d.end.y - d.start.y)
          if (dw > 3 || dh > 3) {
            if (d.tool === 'rect') {
              setOps((o) => [
                ...o,
                {
                  kind: 'rect',
                  x: Math.min(d.start.x, d.end.x),
                  y: Math.min(d.start.y, d.end.y),
                  w: dw,
                  h: dh,
                  color: d.color,
                },
              ])
            } else {
              setOps((o) => [
                ...o,
                { kind: 'arrow', x1: d.start.x, y1: d.start.y, x2: d.end.x, y2: d.end.y, color: d.color },
              ])
            }
          }
        }
        return null
      })
    }
  }

  const undo = () => setOps((o) => o.slice(0, -1))
  const clearAll = () => {
    setOps([])
    setDraft(null)
    setLiveBrush(null)
  }

  const hasBrush = ops.some((o) => o.kind === 'brush')

  const exportComposite = (): string => {
    const canvas = canvasRef.current
    if (!canvas) return ''
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return ''
    }
  }

  const exportMask = (): string | null => {
    const img = imgRef.current
    if (!img || !hasBrush) return null
    const m = document.createElement('canvas')
    m.width = img.naturalWidth
    m.height = img.naturalHeight
    const ctx = m.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, m.width, m.height)
    for (const op of ops) {
      if (op.kind === 'brush') drawBrushPath(ctx, op.points, op.size, '#ffffff')
    }
    try {
      return m.toDataURL('image/png')
    } catch {
      return null
    }
  }

  const submit = () => {
    const text = prompt.trim()
    if (!text) return
    onSubmit({
      prompt: text,
      maskDataUrl: exportMask(),
      annotatedDataUrl: exportComposite(),
    })
  }

  const tools: { key: Tool; label: string; hint: string }[] = [
    { key: 'select', label: '选择', hint: '不绘制' },
    { key: 'rect', label: '矩形框', hint: '拖拽画框' },
    { key: 'arrow', label: '箭头', hint: '拖拽画箭头' },
    { key: 'brush', label: '涂抹', hint: '涂抹区域（作为蒙版）' },
    { key: 'text', label: '文字', hint: '点击放置文字标签' },
  ]

  return (
    <div className="fixed inset-0 z-[70] bg-black/85 flex flex-col" onClick={onClose}>
      <div
        className="flex items-center justify-between px-4 py-2.5 flex-shrink-0 border-b border-line"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-sm text-ink font-medium">图像标注</span>
        <div className="flex items-center gap-2">
          {!showPrompt && (
            <button
              onClick={() => {
                if (!prompt) setPrompt(DEFAULT_GUIDE)
                setShowPrompt(true)
              }}
              disabled={!imgReady}
              className="px-3 py-1.5 rounded-lg bg-sakura hover:bg-sakura text-white text-xs disabled:opacity-50 transition-colors"
            >
              基于标注修改
            </button>
          )}
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-2 hover:bg-elevated text-ink border border-line transition-colors"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2 flex-shrink-0 border-b border-line bg-surface/40"
        onClick={(e) => e.stopPropagation()}
      >
        {tools.map((t) => (
          <button
            key={t.key}
            onClick={() => setTool(t.key)}
            title={t.hint}
            className={[
              'px-2.5 py-1 rounded-md text-xs border transition-colors',
              tool === t.key
                ? 'bg-sakura text-white border-lavender'
                : 'bg-surface-2 text-ink-muted border-line hover:bg-elevated',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}

        <span className="w-px h-5 bg-elevated mx-1" />

        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            title={c}
            className={[
              'w-6 h-6 rounded-full border-2 transition-transform',
              color === c ? 'border-white scale-110' : 'border-line',
            ].join(' ')}
            style={{ backgroundColor: c }}
          />
        ))}

        {tool === 'brush' && (
          <>
            <span className="w-px h-5 bg-elevated mx-1" />
            <span className="text-[11px] text-ink-dim">笔刷</span>
            {[
              { label: '细', v: 16 },
              { label: '中', v: 28 },
              { label: '粗', v: 48 },
            ].map((b) => (
              <button
                key={b.v}
                onClick={() => setBrushSize(b.v)}
                className={[
                  'px-2 py-1 rounded-md text-xs border transition-colors',
                  brushSize === b.v
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-2 text-ink-muted border-line hover:bg-elevated',
                ].join(' ')}
              >
                {b.label}
              </button>
            ))}
          </>
        )}

        <span className="w-px h-5 bg-elevated mx-1" />
        <button
          onClick={undo}
          disabled={ops.length === 0}
          className="px-2.5 py-1 rounded-md text-xs bg-surface-2 text-ink-muted border border-line hover:bg-elevated disabled:opacity-40 transition-colors"
        >
          撤销
        </button>
        <button
          onClick={clearAll}
          disabled={ops.length === 0}
          className="px-2.5 py-1 rounded-md text-xs bg-surface-2 text-ink-muted border border-line hover:bg-elevated disabled:opacity-40 transition-colors"
        >
          清空
        </button>
      </div>

      <div
        className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {loadError ? (
          <div className="text-red-600 text-sm">{loadError}</div>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="max-h-full max-w-full object-contain rounded-lg shadow-xl"
            style={{
              cursor: tool === 'select' ? 'default' : 'crosshair',
              touchAction: 'none',
            }}
          />
        )}
      </div>

      {showPrompt && (
        <div
          className="flex-shrink-0 border-t border-line bg-surface px-4 py-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-ink-muted">
                修改指令{hasBrush ? '（已含涂抹蒙版）' : ''} · 模型 {model || '—'}
              </span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              autoFocus
              className="w-full resize-none rounded-lg bg-bg border border-line px-3 py-2 text-sm text-ink focus:outline-none focus:border-lavender"
              placeholder={DEFAULT_GUIDE}
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => setShowPrompt(false)}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted text-xs border border-line transition-colors disabled:opacity-50"
              >
                返回标注
              </button>
              <button
                onClick={submit}
                disabled={busy || !prompt.trim()}
                className="px-4 py-1.5 rounded-lg bg-sakura hover:bg-sakura text-white text-xs transition-colors disabled:opacity-50"
              >
                {busy ? '生成中…' : '提交修改'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
