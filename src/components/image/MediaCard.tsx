import type { ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { GenMediaRow } from '../../stores/studioStore'

// 画廊卡片（恢复自 698a026 StudioGen 的 MediaCard，图像专用）。
// 变化：去掉视频分支与标注入口；新增收藏（星标）切换。

export function Spinner() {
  return (
    <span className="inline-block w-6 h-6 rounded-full border-2 border-line border-t-blue-400 animate-spin" />
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

export interface MediaCardProps {
  row: GenMediaRow
  fav: boolean
  onOpen: () => void
  onDownload: () => void
  onDelete: () => void
  onCopyPrompt: () => void
  onRetry: () => void
  onToggleFav: () => void
}

export default function MediaCard({
  row,
  fav,
  onOpen,
  onDownload,
  onDelete,
  onCopyPrompt,
  onRetry,
  onToggleFav,
}: MediaCardProps) {
  if (row.status === 'running' || row.status === 'pending') {
    return (
      <div className="group relative aspect-square rounded-xl overflow-hidden border border-line bg-surface/60 flex flex-col items-center justify-center gap-3">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-surface-2/40 to-surface/40" />
        <Spinner />
        <span className="relative text-[11px] text-ink-dim">生成中…</span>
        {/* 手动清除卡住的占位卡（仅移除该条记录） */}
        <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconBtn title="移除该占位" onClick={onDelete} danger>
            ✕
          </IconBtn>
        </div>
      </div>
    )
  }

  if (row.status === 'failed') {
    return (
      <div className="group relative aspect-square rounded-xl overflow-hidden border border-red-900/70 bg-red-950/30 flex flex-col items-center justify-center gap-2 p-3 text-center">
        <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconBtn title="移除该记录" onClick={onDelete} danger>
            ✕
          </IconBtn>
        </div>
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
        <img
          src={src}
          alt={row.prompt}
          loading="lazy"
          className="w-full h-full object-cover"
        />
      </button>

      {/* 收藏星标：已收藏时常显，未收藏时 hover 出现 */}
      <div
        className={[
          'absolute top-1.5 left-1.5 transition-opacity',
          fav ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        ].join(' ')}
      >
        <button
          title={fav ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFav()
          }}
          className={[
            'w-7 h-7 flex items-center justify-center rounded-lg text-sm border backdrop-blur transition-colors',
            fav
              ? 'bg-black/50 border-gold/60 text-gold'
              : 'bg-black/50 border-white/20 text-white hover:text-gold hover:border-gold/60',
          ].join(' ')}
        >
          {fav ? '★' : '☆'}
        </button>
      </div>

      {/* Hover actions */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
        <p className="text-[11px] text-white/90 line-clamp-2 leading-snug">
          {row.prompt}
        </p>
      </div>
    </div>
  )
}
