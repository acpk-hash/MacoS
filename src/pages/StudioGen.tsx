import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import {
  useStudioStore,
  type GenMediaRow,
  type AggModel,
} from '../stores/studioStore'
import Composer from '../components/Composer'
import ImageAnnotator from '../components/ImageAnnotator'
import ModelPicker from '../components/ModelPicker'
import ProviderGuideCard from '../components/ProviderGuideCard'
import { Mascot } from '../components/ui'

// ── Environment guard ─────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

type Mode = 'image' | 'video'

const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const

const EXAMPLE_IMAGE_PROMPTS = [
  '一只戴着宇航头盔的柴犬，漂浮在霓虹星云中，超现实主义，高细节',
  '江南水乡清晨，薄雾中的石桥与乌篷船，水彩画风格，柔和光线',
  '极简主义产品渲染：一台悬浮的复古相机，柔和渐变背景，工作室灯光',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Image models by backend classification (AggModel.kind == "image"),
 *  preserving provider ownership. */
function imageModelsOf(models: AggModel[]): AggModel[] {
  return models.filter((m) => m.kind === 'image')
}

/** Extract the `size` recorded in a media row's params_json. */
function sizeOf(row: GenMediaRow): string | null {
  if (!row.params_json) return null
  try {
    const p = JSON.parse(row.params_json) as { size?: string }
    return p.size ?? null
  } catch {
    return null
  }
}

/** True when this media row was produced by the annotate -> edit flow. */
function isEditedRow(row: GenMediaRow): boolean {
  if (!row.params_json) return false
  try {
    const p = JSON.parse(row.params_json) as { source_media_id?: string }
    return !!p.source_media_id
  } catch {
    return false
  }
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** Save a done media file to a user-chosen location via a real "save as"
 *  dialog, then copy the bytes there through the `media_export` backend
 *  command. Cancelling the dialog is a no-op. */
async function downloadMedia(
  row: GenMediaRow,
  onError: (msg: string) => void,
): Promise<void> {
  if (!row.local_path) return
  try {
    const ext = row.local_path.split('.').pop() || 'png'
    const dest = await save({
      defaultPath: 'agentboard-' + row.id.slice(0, 8) + '.' + ext,
      filters: [{ name: '图片', extensions: [ext] }],
    })
    if (!dest) return // user cancelled
    await invoke('media_export', { id: row.id, destPath: dest })
  } catch (e) {
    onError('下载失败：' + String(e))
  }
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span className="inline-block w-6 h-6 rounded-full border-2 border-line border-t-blue-400 animate-spin" />
  )
}

// ── Mode switch (segmented control) ───────────────────────────────────────────

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: Mode
  onChange: (m: Mode) => void
}) {
  const tabs: { key: Mode; label: string }[] = [
    { key: 'image', label: '图像' },
    { key: 'video', label: '视频' },
  ]
  return (
    <div className="inline-flex p-0.5 rounded-lg bg-surface-2 border border-line">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={[
            'px-3.5 py-1 rounded-md text-xs font-medium transition-colors',
            mode === t.key
              ? 'bg-sakura text-white'
              : 'text-ink-muted hover:text-ink',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Params bar (rendered inside the composer as a slot) ───────────────────────

function ParamsBar({
  disabled,
  imageModels,
  providerId,
  model,
  onSelect,
  size,
  onSize,
  count,
  onCount,
}: {
  disabled: boolean
  imageModels: AggModel[]
  providerId: string
  model: string
  onSelect: (providerId: string, modelId: string) => void
  size: string
  onSize: (v: string) => void
  count: number
  onCount: (v: number) => void
}) {
  const selCls =
    'bg-surface border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-[11px] text-ink-dim">模型</label>
      <ModelPicker
        models={imageModels}
        value={{ providerId, modelId: model }}
        onChange={(v) => onSelect(v.providerId, v.modelId)}
        disabled={disabled}
        title="图像模型"
        emptyLabel="无可用图像模型"
        className={selCls + ' max-w-[180px]'}
      />

      <label className="text-[11px] text-ink-dim ml-1">尺寸</label>
      <select
        value={size}
        disabled={disabled}
        onChange={(e) => onSize(e.target.value)}
        className={selCls}
        title="尺寸"
      >
        {IMAGE_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <label className="text-[11px] text-ink-dim ml-1">数量</label>
      <select
        value={count}
        disabled={disabled}
        onChange={(e) => onCount(Number(e.target.value))}
        className={selCls}
        title="生成数量"
      >
        {[1, 2, 3, 4].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Gallery card ──────────────────────────────────────────────────────────────

function MediaCard({
  row,
  onOpen,
  onDownload,
  onDelete,
  onCopyPrompt,
  onRetry,
  onAnnotate,
}: {
  row: GenMediaRow
  onOpen: () => void
  onDownload: () => void
  onDelete: () => void
  onCopyPrompt: () => void
  onRetry: () => void
  onAnnotate: () => void
}) {
  if (row.status === 'running' || row.status === 'pending') {
    return (
      <div className="relative aspect-square rounded-xl overflow-hidden border border-line bg-surface/60 flex flex-col items-center justify-center gap-3">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-surface-2/40 to-surface/40" />
        <Spinner />
        <span className="relative text-[11px] text-ink-dim">生成中…</span>
      </div>
    )
  }

  if (row.status === 'failed') {
    return (
      <div className="relative aspect-square rounded-xl overflow-hidden border border-red-900/70 bg-red-950/30 flex flex-col items-center justify-center gap-2 p-3 text-center">
        <span className="text-failed text-xs font-medium">生成失败</span>
        <span
          className="text-[11px] text-failed line-clamp-3 break-words"
          title={row.error ?? ''}
        >
          {row.error ?? '未知错误'}
        </span>
        <button
          onClick={onRetry}
          className="mt-1 px-2.5 py-1 rounded-lg bg-red-900/60 hover:bg-red-800 text-red-100 text-[11px] border border-[#f8514940] transition-colors"
        >
          重试
        </button>
      </div>
    )
  }

  // done
  const src = row.local_path ? convertFileSrc(row.local_path) : ''
  return (
    <div className="group relative aspect-square rounded-xl overflow-hidden border border-line bg-surface">
      <button onClick={onOpen} className="block w-full h-full" title="查看大图">
        {row.kind === 'video' ? (
          <video
            src={src}
            className="w-full h-full object-cover"
            muted
            playsInline
          />
        ) : (
          <img
            src={src}
            alt={row.prompt}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        )}
      </button>

      {/* Hover actions */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {row.kind === 'image' && (
          <IconBtn title="标注修改" onClick={onAnnotate}>
            ✎
          </IconBtn>
        )}
        <IconBtn title="下载" onClick={onDownload}>
          ↓
        </IconBtn>
        <IconBtn title="复制提示词" onClick={onCopyPrompt}>
          ⧉
        </IconBtn>
        <IconBtn title="删除" onClick={onDelete} danger>
          ✕
        </IconBtn>
      </div>

      {/* Prompt caption on hover */}
      <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <p className="text-[11px] text-ink line-clamp-2 leading-snug">
          {row.prompt}
        </p>
      </div>
    </div>
  )
}

function IconBtn({
  children,
  title,
  onClick,
  danger,
}: {
  children: ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={[
        'w-7 h-7 flex items-center justify-center rounded-lg text-sm border backdrop-blur transition-colors',
        danger
          ? 'bg-black/50 border-white/20 text-white hover:bg-[#da3633] hover:border-failed'
          : 'bg-black/50 border-white/20 text-white hover:bg-elevated/20',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ── Lightbox (full-image viewer) ──────────────────────────────────────────────

function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  onDownload,
  onDelete,
  onAnnotate,
}: {
  items: GenMediaRow[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  onDownload: (row: GenMediaRow) => void
  onDelete: (row: GenMediaRow) => void
  onAnnotate: (row: GenMediaRow) => void
}) {
  const row = items[index]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1))
      else if (e.key === 'ArrowRight') onIndex(Math.min(items.length - 1, index + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onClose, onIndex])

  if (!row) return null
  const src = row.local_path ? convertFileSrc(row.local_path) : ''
  const size = sizeOf(row)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex flex-col"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-xs text-ink-muted">
          {index + 1} / {items.length}
        </span>
        <div className="flex items-center gap-2">
          {row.kind === 'image' && (
            <button
              onClick={() => onAnnotate(row)}
              className="px-3 py-1.5 rounded-lg bg-sakura hover:bg-sakura text-white text-xs transition-colors"
            >
              标注修改
            </button>
          )}
          <button
            onClick={() => onDownload(row)}
            className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink text-xs border border-line transition-colors"
          >
            下载
          </button>
          <button
            onClick={() => onDelete(row)}
            className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-[#da3633] text-ink text-xs border border-line hover:border-failed transition-colors"
          >
            删除
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-2 hover:bg-elevated text-ink border border-line transition-colors"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Image area with nav arrows */}
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {index > 0 && (
          <button
            onClick={() => onIndex(index - 1)}
            className="absolute left-4 w-10 h-10 flex items-center justify-center rounded-full bg-surface-2/80 hover:bg-elevated text-ink border border-line transition-colors"
            title="上一张 (←)"
          >
            ‹
          </button>
        )}
        {row.kind === 'video' ? (
          <video src={src} controls className="max-h-full max-w-full rounded-lg" />
        ) : (
          <img
            src={src}
            alt={row.prompt}
            className="max-h-full max-w-full object-contain rounded-lg"
          />
        )}
        {index < items.length - 1 && (
          <button
            onClick={() => onIndex(index + 1)}
            className="absolute right-4 w-10 h-10 flex items-center justify-center rounded-full bg-surface-2/80 hover:bg-elevated text-ink border border-line transition-colors"
            title="下一张 (→)"
          >
            ›
          </button>
        )}
      </div>

      {/* Meta footer */}
      <div
        className="flex-shrink-0 px-4 py-3 max-w-3xl mx-auto w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-ink break-words mb-1.5">{row.prompt}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-dim">
          <span>模型：{row.model || '—'}</span>
          {size && <span>尺寸：{size}</span>}
          {isEditedRow(row) && <span className="text-sky">由标注修改而来</span>}
          <span>时间：{formatTime(row.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Empty states ──────────────────────────────────────────────────────────────

function ImageEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <Mascot mood="idle" size={92} className="mb-4" />
      <h1 className="text-2xl font-bold text-gradient mb-1">开始生成图像</h1>
      <p className="text-sm text-ink-dim mb-8">
        在下方输入描述，或从示例开始，生成结果会出现在这里
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-3xl">
        {EXAMPLE_IMAGE_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="text-left px-4 py-3 rounded-card glass hover:-translate-y-0.5 hover:border-line-strong text-sm text-ink-muted leading-relaxed transition-all duration-150"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

function VideoLockedState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full rounded-pop glass-strong px-6 py-10 flex flex-col items-center text-center gap-3">
        <Mascot mood="sad" size={72} />
        <h2 className="text-lg font-semibold text-ink-muted">视频生成暂未开通</h2>
        <p className="text-sm text-ink-dim leading-relaxed">
          当前 API 未开通视频模型——开通后此处将自动可用。
        </p>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StudioGen() {
  const {
    aggModels,
    modelsLoaded,
    media,
    mediaLoaded,
    capabilities,
    loadModels,
    loadCapabilities,
    loadMedia,
    generateImage,
    editImage,
    deleteMedia,
  } = useStudioStore()

  const [mode, setMode] = useState<Mode>('image')
  const [draft, setDraft] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [imageProviderId, setImageProviderId] = useState('')
  const [size, setSize] = useState<string>('1024x1024')
  const [count, setCount] = useState(1)
  const [toast, setToast] = useState<string | null>(null)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<(typeof media)[number] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [annotateRow, setAnnotateRow] = useState<GenMediaRow | null>(null)
  const [annotateBusy, setAnnotateBusy] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const toastTimer = useRef<number | null>(null)

  const imageModels = useMemo(() => imageModelsOf(aggModels), [aggModels])
  const videoEnabled = !!capabilities?.video
  // 已加载完成但没有任何服务商 / 可用模型（首启或全部失败）。
  const noProviders = modelsLoaded && aggModels.length === 0

  /** Select an image model together with its owning provider. */
  const selectImageModel = (providerId: string, modelId: string) => {
    setImageProviderId(providerId)
    setImageModel(modelId)
  }

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  // Initial load.
  useEffect(() => {
    if (!isTauri) return
    loadModels()
    loadCapabilities()
    loadMedia('image')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selected image model valid as the model list resolves.
  useEffect(() => {
    if (imageModels.length === 0) return
    if (!imageModel || !imageModels.some((m) => m.modelId === imageModel)) {
      selectImageModel(imageModels[0].providerId, imageModels[0].modelId)
    }
  }, [imageModels, imageModel])

  // Reload the gallery for the active mode.
  useEffect(() => {
    if (!isTauri) return
    loadMedia(mode)
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Items eligible for the lightbox (finished, with a local file).
  const doneItems = useMemo(
    () => media.filter((m) => m.status === 'done' && m.local_path),
    [media],
  )

  // Keep the lightbox index in range as items are added/removed.
  useEffect(() => {
    if (lightboxIdx == null) return
    if (doneItems.length === 0) setLightboxIdx(null)
    else if (lightboxIdx >= doneItems.length) setLightboxIdx(doneItems.length - 1)
  }, [doneItems.length, lightboxIdx])

  const handleGenerate = async (content: string) => {
    if (mode !== 'image') return
    if (!imageModel) {
      showToast('当前没有可用的图像模型')
      return
    }
    setSubmitting(true)
    try {
      await generateImage(content, imageModel, size, count, imageProviderId || null)
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetry = (row: GenMediaRow) => {
    setMode('image')
    setDraft(row.prompt)
    const s = sizeOf(row)
    if (s) setSize(s)
    const match = row.model
      ? imageModels.find((m) => m.modelId === row.model)
      : undefined
    if (match) selectImageModel(match.providerId, match.modelId)
    setFocusToken((t) => t + 1)
  }

  const handleAnnotateSubmit = async (args: {
    prompt: string
    maskDataUrl: string | null
    annotatedDataUrl: string
  }) => {
    const src = annotateRow
    if (!src) return
    setAnnotateBusy(true)
    try {
      await editImage({
        sourceMediaId: src.id,
        model: imageModel || src.model,
        prompt: args.prompt,
        size: sizeOf(src) ?? size,
        maskDataUrl: args.maskDataUrl,
        annotatedDataUrl: args.annotatedDataUrl,
      })
      setAnnotateRow(null)
      showToast('已提交修改，生成中…')
    } catch (e) {
      showToast('修改失败：' + String(e))
    } finally {
      setAnnotateBusy(false)
    }
  }

  const copyPrompt = async (row: GenMediaRow) => {
    try {
      await navigator.clipboard.writeText(row.prompt)
      showToast('已复制提示词')
    } catch {
      showToast('复制失败')
    }
  }

  const openLightbox = (row: GenMediaRow) => {
    const i = doneItems.findIndex((m) => m.id === row.id)
    if (i >= 0) setLightboxIdx(i)
  }

  const composerDisabled =
    mode === 'video' || (mode === 'image' && imageModels.length === 0)

  const plusMenu = (close: () => void) => (
    <div className="w-44 py-1 rounded-lg bg-surface-2 border border-line shadow-xl max-h-72 overflow-y-auto">
      <div className="px-3 py-1 text-[10px] text-ink-dim select-none">模式</div>
      {(['image', 'video'] as Mode[]).map((m) => (
        <button
          key={m}
          onClick={() => {
            setMode(m)
            close()
          }}
          className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
        >
          <span>{m === 'image' ? '图像' : '视频'}</span>
          {mode === m && <span className="text-sky">✓</span>}
        </button>
      ))}
      <div className="border-t border-line my-1" />
      <div className="px-3 py-1 text-[10px] text-ink-dim select-none">图像模型</div>
      {imageModels.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-ink-dim">暂无可用模型</div>
      )}
      {imageModels.map((m) => (
        <button
          key={`${m.providerId}|${m.modelId}`}
          onClick={() => {
            selectImageModel(m.providerId, m.modelId)
            setMode('image')
            close()
          }}
          className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
        >
          <span className="truncate">{m.modelId}</span>
          {imageModel === m.modelId && imageProviderId === m.providerId && (
            <span className="text-sky ml-1">✓</span>
          )}
        </button>
      ))}
    </div>
  )

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
        <p className="text-ink-dim text-xs">
          此功能需要 Tauri 桌面运行时，无法在普通浏览器中运行。
        </p>
      </div>
    )
  }

  const showImageEmpty =
    mode === 'image' && mediaLoaded && media.length === 0
  const showImageGrid = mode === 'image' && media.length > 0
  const showVideoGrid = mode === 'video' && videoEnabled && media.length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="px-4 py-2 border-b border-line flex-shrink-0 flex items-center gap-3 min-h-[48px]">
        <ModeSwitch mode={mode} onChange={setMode} />
        <div className="flex-1" />
        <span className="text-xs text-ink-dim truncate max-w-[200px]">
          {mode === 'image' ? imageModel || '无可用图像模型' : '视频模式'}
        </span>
      </div>

      {/* Main area */}
      <div className="flex-1 min-h-0 flex flex-col">
        {mode === 'video' && !videoEnabled ? (
          <VideoLockedState />
        ) : mode === 'image' && noProviders ? (
          <div className="flex-1 flex items-center justify-center px-4">
            <ProviderGuideCard
              title="还没有配置模型服务"
              hint="添加一个 OpenAI 兼容服务商（Base URL + API Key）后，这里就能用图像模型开始创作。"
            />
          </div>
        ) : showImageEmpty ? (
          <ImageEmptyState onPick={(t) => setDraft(t)} />
        ) : showImageGrid || showVideoGrid ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {media.map((row) => (
                <MediaCard
                  key={row.id}
                  row={row}
                  onOpen={() => openLightbox(row)}
                  onDownload={() => void downloadMedia(row, showToast)}
                  onDelete={() => setConfirmDelete(row)}
                  onCopyPrompt={() => void copyPrompt(row)}
                  onRetry={() => handleRetry(row)}
                  onAnnotate={() => setAnnotateRow(row)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}
      </div>

      {/* Composer with params slot */}
      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={(content) => void handleGenerate(content)}
        disabled={composerDisabled}
        busy={submitting}
        showToast={showToast}
        attachmentsEnabled={false}
        requireContent
        focusToken={focusToken}
        renderPlusMenu={plusMenu}
        placeholder={
          mode === 'video'
            ? '视频生成暂未开通，切换到图像模式开始创作'
            : noProviders
              ? '未配置模型服务——请先到「设置」添加服务商'
              : modelsLoaded && imageModels.length === 0
                ? '当前服务商没有可用的图像模型'
                : '描述你想生成的图像，Enter 生成 / Shift+Enter 换行'
        }
        footerHint={
          mode === 'image'
            ? '图像由 AI 生成，可能与描述存在差异。'
            : null
        }
        paramsSlot={
          <ParamsBar
            disabled={mode === 'video'}
            imageModels={imageModels}
            providerId={imageProviderId}
            model={imageModel}
            onSelect={selectImageModel}
            size={size}
            onSize={setSize}
            count={count}
            onCount={setCount}
          />
        }
      />

      {/* Lightbox */}
      {lightboxIdx != null && doneItems[lightboxIdx] && (
        <Lightbox
          items={doneItems}
          index={lightboxIdx}
          onIndex={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onDownload={(row) => void downloadMedia(row, showToast)}
          onDelete={(row) => setConfirmDelete(row)}
          onAnnotate={(row) => setAnnotateRow(row)}
        />
      )}

      {/* Image annotator (annotate -> second-pass edit) */}
      {annotateRow && (
        <ImageAnnotator
          row={annotateRow}
          model={imageModel || annotateRow.model}
          busy={annotateBusy}
          onClose={() => {
            if (!annotateBusy) setAnnotateRow(null)
          }}
          onSubmit={(a) => void handleAnnotateSubmit(a)}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface border border-line rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-ink mb-1 font-medium">
              删除该{confirmDelete.kind === 'video' ? '视频' : '图片'}？
            </p>
            <p className="text-xs text-ink-muted mb-4 truncate">{confirmDelete.prompt}</p>
            <p className="text-xs text-ink-dim mb-4">此操作会永久删除本地文件，无法撤销。</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted border border-line transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  void deleteMedia(confirmDelete.id)
                  setConfirmDelete(null)
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#da3633] hover:bg-failed text-white border border-failed transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg bg-surface-2 border border-line text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
