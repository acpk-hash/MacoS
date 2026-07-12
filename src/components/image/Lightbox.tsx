import { useEffect } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { GenMediaRow } from '../../stores/studioStore'
import { formatTime, isEditedRow, sizeOf } from './mediaUtils'

// 灯箱（恢复自 698a026 StudioGen 的 Lightbox，图像专用）。
// 变化：去掉视频分支与标注入口；新增收藏切换。键盘 Esc 关闭、左右键翻页。

export interface LightboxProps {
  items: GenMediaRow[]
  index: number
  fav: boolean
  onIndex: (i: number) => void
  onClose: () => void
  onDownload: (row: GenMediaRow) => void
  onDelete: (row: GenMediaRow) => void
  onToggleFav: (row: GenMediaRow) => void
}

export default function Lightbox({
  items,
  index,
  fav,
  onIndex,
  onClose,
  onDownload,
  onDelete,
  onToggleFav,
}: LightboxProps) {
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
          <button
            onClick={() => onToggleFav(row)}
            className={[
              'px-3 py-1.5 rounded-lg text-xs border transition-colors',
              fav
                ? 'bg-gold/15 border-gold/60 text-gold'
                : 'bg-surface-2 border-line text-ink hover:text-gold hover:border-gold/60',
            ].join(' ')}
          >
            {fav ? '★ 已收藏' : '☆ 收藏'}
          </button>
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
        <img
          src={src}
          alt={row.prompt}
          className="max-h-full max-w-full object-contain rounded-lg"
        />
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
