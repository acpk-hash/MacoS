import { useEffect, useRef } from 'react'
import { useImageStore, MAX_REFS, type RefItem } from '../../stores/imageStore'

// 「参考」区 —— 提示词工作台的参考输入（V2 ①）。
// 图片：上传 / Ctrl+V 粘贴 → 压缩为 data URL → 多模态 chat 后台提炼风格描述，
//       生成时并入提示词（后端 image_generate 无参考图参数，此为明示的降级路径）。
// 文件：txt/md 读文本 → 生成时以「参考文件（节选）」并入提示词。
// chips 可删；分析状态跨页面导航保留（都在 imageStore）。

const TEXT_EXT = /\.(txt|md|markdown)$/i
/** 参考图长边上限（压到该尺寸再入库，控制 data URL 体积）。 */
const REF_IMAGE_MAX_EDGE = 1024

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsDataURL(blob)
  })
}

/** 超出长边上限的图片等比压缩为 JPEG data URL（透明区铺白底）。 */
function downscaleImage(dataUrl: string, maxEdge = REF_IMAGE_MAX_EDGE): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h || (w <= maxEdge && h <= maxEdge)) {
        resolve(dataUrl)
        return
      }
      const k = Math.min(maxEdge / w, maxEdge / h)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * k))
      canvas.height = Math.max(1, Math.round(h * k))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.88))
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function RefChip({ item, onRemove }: { item: RefItem; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-chip bg-surface-2 border border-line group">
      {item.kind === 'image' ? (
        item.dataUrl ? (
          <img
            src={item.dataUrl}
            alt={item.name}
            className="w-7 h-7 rounded object-cover border border-line flex-shrink-0"
          />
        ) : (
          <span className="w-7 h-7 flex items-center justify-center text-sm flex-shrink-0">🖼</span>
        )
      ) : (
        <span className="w-7 h-7 flex items-center justify-center text-sm flex-shrink-0">📄</span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-ink truncate" title={item.name}>
          {item.name}
        </p>
        {item.kind === 'image' ? (
          item.status === 'analyzing' ? (
            <p className="text-[11px] text-running flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-line border-t-running animate-spin" />
              风格分析中…
            </p>
          ) : item.status === 'done' ? (
            <p className="text-[11px] text-done truncate" title={item.styleDesc}>
              已转为风格描述
            </p>
          ) : (
            <p className="text-[11px] text-failed truncate" title={item.error ?? ''}>
              分析失败，生成时将跳过
            </p>
          )
        ) : (
          <p className="text-[11px] text-ink-dim">
            {(item.text ?? '').length} 字{item.truncated ? '（已截断）' : ''} · 并入提示词
          </p>
        )}
      </div>
      <button
        onClick={onRemove}
        title="移除该参考"
        className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-[11px] text-ink-dim hover:text-failed hover:bg-elevated transition-colors"
      >
        ✕
      </button>
    </div>
  )
}

export default function ReferencePanel({
  onToast,
}: {
  onToast: (msg: string) => void
}) {
  const { refs, addImageRef, addFileRef, removeRef } = useImageStore()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const ingestFiles = async (files: File[]) => {
    for (const f of files) {
      if (useImageStore.getState().refs.length >= MAX_REFS) {
        onToast(`参考最多 ${MAX_REFS} 项`)
        return
      }
      try {
        if (f.type.startsWith('image/')) {
          const raw = await blobToDataUrl(f)
          const dataUrl = await downscaleImage(raw)
          addImageRef(f.name || '粘贴图片.png', dataUrl)
        } else if (
          TEXT_EXT.test(f.name) ||
          f.type === 'text/plain' ||
          f.type === 'text/markdown'
        ) {
          const text = await f.text()
          if (!text.trim()) {
            onToast(`「${f.name}」是空文件，已忽略`)
            continue
          }
          addFileRef(f.name, text)
        } else {
          onToast(`不支持的参考类型：${f.name}（仅图片 / txt / md）`)
        }
      } catch (e) {
        onToast(`读取「${f.name}」失败：${String(e)}`)
      }
    }
  }

  // Ctrl+V 粘贴图片（仅本页挂载期间生效；纯文本粘贴不拦截）。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imgs: File[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) imgs.push(f)
        }
      }
      if (imgs.length === 0) return
      e.preventDefault()
      void ingestFiles(imgs)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasImageRef = refs.some((r) => r.kind === 'image')

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-dim tracking-wide">
          参考（图片 / 文件）
        </span>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="text-[11px] px-2 py-0.5 rounded-md bg-surface-2 border border-line text-ink-muted hover:bg-elevated hover:text-ink transition-colors"
        >
          + 添加
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.markdown,text/plain,text/markdown"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void ingestFiles(Array.from(e.target.files))
          e.target.value = ''
        }}
      />

      {refs.length === 0 ? (
        <p className="text-[11px] text-ink-faint leading-relaxed">
          可「+ 添加」或 Ctrl+V 粘贴参考图片，也可添加 txt/md 文件，生成时并入提示词。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {refs.map((r) => (
            <RefChip key={r.id} item={r} onRemove={() => removeRef(r.id)} />
          ))}
        </div>
      )}

      {hasImageRef && (
        <p className="text-[11px] text-sky leading-relaxed">
          当前生成链路不支持直接图生图：参考图会由多模态模型转为「风格描述」并入提示词。
        </p>
      )}
    </div>
  )
}
