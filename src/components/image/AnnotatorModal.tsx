import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { GenMediaRow } from '../../stores/studioStore'
import {
  useImageStore,
  ANNO_COLORS,
  type AnnoOp,
  type AnnoPoint,
  type AnnoTool,
} from '../../stores/imageStore'

// 「再加工」标注工作台（V2 ②）—— 适配自 698a026 ImageAnnotator：
//  - 深色遮罩翻为白色主题全屏工作台；
//  - 工具/颜色/笔迹/指令等编辑状态提升到 imageStore（导航离开再回来不丢）；
//  - 提交走 imageStore.submitEdit → 后端 image_edit（涂抹导出为黑底白笔迹蒙版，
//    合成标注图一并上报），新图作为新记录入画廊并记录来源。
// 画布上的拖拽中间态（draft 形状 / 实时笔迹）保留在组件内。

const DEFAULT_GUIDE =
  '请描述你想对标注区域做的修改，例如：把红框里的物体替换为……／让涂抹区域变成……'

/** 涂抹笔迹在画布上的预览色（半透明品红，导出蒙版时为纯白）。 */
const BRUSH_PREVIEW = 'rgba(236,72,153,0.5)'

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
  points: AnnoPoint[],
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

interface DraftShape {
  tool: 'rect' | 'arrow'
  start: AnnoPoint
  end: AnnoPoint
  color: string
}

export default function AnnotatorModal({ row }: { row: GenMediaRow }) {
  const annotator = useImageStore((s) => s.annotator)
  const { patchAnnotator, closeAnnotator, submitEdit } = useImageStore()
  const imageModel = useImageStore((s) => s.imageModel)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgReady, setImgReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 拖拽中间态（不入 store）。
  const [draft, setDraft] = useState<DraftShape | null>(null)
  const [liveBrush, setLiveBrush] = useState<AnnoPoint[] | null>(null)
  const drawingRef = useRef(false)

  const busy = annotator?.submitting ?? false

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) closeAnnotator()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, closeAnnotator])

  // 原图经同源 blob 加载，保持画布未被污染（toDataURL 可用）。
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

  const ops = annotator ? annotator.ops : []
  const tool = annotator ? annotator.tool : 'rect'
  const color = annotator ? annotator.color : ANNO_COLORS[0]
  const brushSize = annotator ? annotator.brushSize : 28
  const prompt = annotator ? annotator.prompt : ''
  const showPrompt = annotator ? annotator.showPrompt : false

  const lineWidth = imgRef.current
    ? Math.max(2, Math.round(imgRef.current.naturalWidth / 320))
    : 3

  // 重绘：原图 + 已确认标注 + 拖拽中的形状/笔迹。
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
        ctx.font = 'bold ' + font + 'px sans-serif'
        ctx.textBaseline = 'top'
        ctx.lineWidth = Math.max(2, font / 8)
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'
        ctx.strokeText(op.text, op.x, op.y)
        ctx.fillStyle = op.color
        ctx.fillText(op.text, op.x, op.y)
      } else {
        drawBrushPath(ctx, op.points, op.size, BRUSH_PREVIEW)
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
    if (liveBrush) drawBrushPath(ctx, liveBrush, brushSize, BRUSH_PREVIEW)
  }, [imgReady, ops, draft, liveBrush, lineWidth, brushSize])

  if (!annotator) return null

  const setOps = (next: AnnoOp[]) => patchAnnotator({ ops: next })

  const toPoint = (e: ReactPointerEvent<HTMLCanvasElement>): AnnoPoint => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imgReady || busy) return
    const p = toPoint(e)
    if (tool === 'select') return
    if (tool === 'text') {
      const text = window.prompt('文字标签内容')
      if (text && text.trim()) {
        setOps([...ops, { kind: 'text', x: p.x, y: p.y, text: text.trim(), color }])
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
          const cur = useImageStore.getState().annotator
          if (cur) {
            patchAnnotator({
              ops: [...cur.ops, { kind: 'brush', points: pts, size: brushSize }],
            })
          }
        }
        return null
      })
    } else {
      setDraft((d) => {
        if (d) {
          const dw = Math.abs(d.end.x - d.start.x)
          const dh = Math.abs(d.end.y - d.start.y)
          if (dw > 3 || dh > 3) {
            const cur = useImageStore.getState().annotator
            if (cur) {
              const op: AnnoOp =
                d.tool === 'rect'
                  ? {
                      kind: 'rect',
                      x: Math.min(d.start.x, d.end.x),
                      y: Math.min(d.start.y, d.end.y),
                      w: dw,
                      h: dh,
                      color: d.color,
                    }
                  : {
                      kind: 'arrow',
                      x1: d.start.x,
                      y1: d.start.y,
                      x2: d.end.x,
                      y2: d.end.y,
                      color: d.color,
                    }
              patchAnnotator({ ops: [...cur.ops, op] })
            }
          }
        }
        return null
      })
    }
  }

  const undo = () => setOps(ops.slice(0, -1))
  const clearAll = () => {
    setOps([])
    setDraft(null)
    setLiveBrush(null)
  }

  const hasBrush = ops.some((o) => o.kind === 'brush')

  /** 导出「原图 + 标注」合成图。 */
  const exportComposite = (): string | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }

  /** 导出涂抹蒙版（黑底白笔迹），无涂抹时为 null。 */
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
    if (!prompt.trim() || busy) return
    void submitEdit({
      maskDataUrl: exportMask(),
      annotatedDataUrl: exportComposite(),
    })
  }

  const tools: { key: AnnoTool; label: string; hint: string }[] = [
    { key: 'select', label: '选择', hint: '不绘制' },
    { key: 'rect', label: '矩形框', hint: '拖拽画框' },
    { key: 'arrow', label: '箭头', hint: '拖拽画箭头' },
    { key: 'brush', label: '涂抹', hint: '涂抹区域（作为修改蒙版）' },
    { key: 'text', label: '文字', hint: '点击放置文字标签' },
  ]

  return (
    <div className="fixed inset-0 z-[70] bg-bg flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 flex-shrink-0 border-b border-line bg-editor">
        <div className="min-w-0">
          <span className="text-sm text-ink font-medium">再加工 · 图像标注</span>
          <span className="ml-3 text-[11px] text-ink-dim truncate">
            结果将作为新图入画廊，并记录来源，可继续多轮再加工
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!showPrompt && (
            <button
              onClick={() => {
                patchAnnotator(
                  prompt
                    ? { showPrompt: true }
                    : { showPrompt: true, prompt: DEFAULT_GUIDE },
                )
              }}
              disabled={!imgReady}
              className="px-3 py-1.5 rounded-lg bg-grad-primary text-white text-xs disabled:opacity-50 hover:-translate-y-px transition-all"
            >
              基于标注修改
            </button>
          )}
          <button
            onClick={() => {
              if (!busy) closeAnnotator()
            }}
            disabled={busy}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-2 hover:bg-elevated text-ink border border-line transition-colors disabled:opacity-50"
            title={busy ? '生成中…' : '关闭 (Esc)'}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 flex-shrink-0 border-b border-line bg-surface">
        {tools.map((t) => (
          <button
            key={t.key}
            onClick={() => patchAnnotator({ tool: t.key })}
            title={t.hint}
            className={[
              'px-2.5 py-1 rounded-md text-xs border transition-colors',
              tool === t.key
                ? 'bg-primary text-white border-primary'
                : 'bg-surface-2 text-ink-muted border-line hover:bg-elevated',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}

        <span className="w-px h-5 bg-line-strong mx-1" />

        {ANNO_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => patchAnnotator({ color: c })}
            title={c}
            className={[
              'w-6 h-6 rounded-full border-2 transition-transform',
              color === c ? 'border-primary scale-110' : 'border-line',
            ].join(' ')}
            style={{ backgroundColor: c }}
          />
        ))}

        {tool === 'brush' && (
          <>
            <span className="w-px h-5 bg-line-strong mx-1" />
            <span className="text-[11px] text-ink-dim">笔刷</span>
            {[
              { label: '细', v: 16 },
              { label: '中', v: 28 },
              { label: '粗', v: 48 },
            ].map((b) => (
              <button
                key={b.v}
                onClick={() => patchAnnotator({ brushSize: b.v })}
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

        <span className="w-px h-5 bg-line-strong mx-1" />
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

      {/* 画布区 */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto bg-surface-2">
        {loadError ? (
          <div className="text-failed text-sm">{loadError}</div>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="max-h-full max-w-full object-contain rounded-lg shadow-pop border border-line bg-editor"
            style={{
              cursor: tool === 'select' || busy ? 'default' : 'crosshair',
              touchAction: 'none',
            }}
          />
        )}
      </div>

      {/* 指令输入 */}
      {showPrompt && (
        <div className="flex-shrink-0 border-t border-line bg-editor px-4 py-3">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-ink-muted">
                修改指令{hasBrush ? '（已含涂抹蒙版）' : ''} · 模型 {imageModel || '—'}
              </span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => patchAnnotator({ prompt: e.target.value })}
              rows={3}
              autoFocus
              disabled={busy}
              className="w-full resize-none rounded-lg bg-surface-2 border border-line px-3 py-2 text-sm text-ink focus:outline-none focus:border-lavender disabled:opacity-60"
              placeholder={DEFAULT_GUIDE}
            />
            {annotator.error && (
              <p className="mt-1.5 text-xs text-failed break-words">
                修改失败：{annotator.error}
              </p>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => patchAnnotator({ showPrompt: false })}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted text-xs border border-line transition-colors disabled:opacity-50"
              >
                返回标注
              </button>
              <button
                onClick={submit}
                disabled={busy || !prompt.trim()}
                className="px-4 py-1.5 rounded-lg bg-grad-primary text-white text-xs transition-all hover:-translate-y-px disabled:opacity-50 disabled:translate-y-0"
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
