import { useCallback, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useVideoStore, type VideoFileInfo } from '../../stores/videoStore'

// 视频上传区域：拖拽/点击选择/粘贴。
// 使用 plugin-dialog 的 open() 选择文件；拖拽/粘贴走浏览器原生 File API。
// 大于 50MB 的视频不预览，只显示元信息。

const MAX_PREVIEW_BYTES = 50 * 1024 * 1024
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'm4v']

interface Props {
  onToast: (msg: string) => void
}

export default function VideoUploader({ onToast }: Props) {
  const { video, setVideo, setDuration } = useVideoStore()
  const [dragOver, setDragOver] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!VIDEO_EXTS.includes(ext)) {
        onToast('不支持的文件格式，请选择视频文件')
        return
      }
      const previewUrl =
        file.size <= MAX_PREVIEW_BYTES ? URL.createObjectURL(file) : null
      const info: VideoFileInfo = {
        path: file.name,
        name: file.name,
        size: file.size,
        duration: null,
        previewUrl,
      }
      setVideo(info)
    },
    [setVideo, onToast],
  )

  const handleDialogPick = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [
          { name: '视频', extensions: VIDEO_EXTS },
        ],
      })
      if (!selected) return
      const filePath = (typeof selected === 'string' ? selected : (selected as unknown as string)) as string

      const previewUrl = convertFileSrc(filePath)
      const name = filePath.split(/[\/]/).pop() ?? 'video'

      const info: VideoFileInfo = {
        path: filePath,
        name,
        size: 0,
        duration: null,
        previewUrl,
      }
      setVideo(info)
    } catch (e) {
      onToast('选择文件失败：' + String(e))
    }
  }, [setVideo, onToast])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const file = e.clipboardData.files[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  const onMetadata = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    setDuration(el.duration)
  }, [setDuration])

  const clearVideo = useCallback(() => {
    if (video?.previewUrl && video.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(video.previewUrl)
    }
    setVideo(null)
  }, [video, setVideo])

  if (video) {
    const sizeMB = video.size > 0 ? (video.size / (1024 * 1024)).toFixed(1) + ' MB' : ''
    const durStr = video.duration != null
      ? `${Math.floor(video.duration / 60)}:${String(Math.round(video.duration % 60)).padStart(2, '0')}`
      : ''

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-ink-dim tracking-wide">
            已加载视频
          </span>
          <button
            onClick={clearVideo}
            className="text-[11px] text-ink-dim hover:text-failed transition-colors"
          >
            移除
          </button>
        </div>

        {video.previewUrl ? (
          <div className="rounded-lg overflow-hidden border border-line bg-black">
            <video
              ref={videoRef}
              src={video.previewUrl}
              controls
              onLoadedMetadata={onMetadata}
              className="w-full max-h-[200px] object-contain"
            />
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-surface-2 px-4 py-6 flex flex-col items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-8 w-8 text-ink-faint"
            >
              <path d="m22 8-6 4 6 4V8Z" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </svg>
            <p className="text-xs text-ink-dim">
              视频过大（&gt;50MB），不预览
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] text-ink-dim">
          <span className="truncate flex-1" title={video.name}>{video.name}</span>
          {sizeMB && <span>{sizeMB}</span>}
          {durStr && <span>{durStr}</span>}
        </div>
      </div>
    )
  }

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onPaste={onPaste}
      tabIndex={0}
      className={[
        'rounded-lg border-2 border-dashed px-4 py-8 flex flex-col items-center gap-3 cursor-pointer transition-colors focus:outline-none',
        dragOver
          ? 'border-lavender bg-lavender/5'
          : 'border-line hover:border-ink-dim bg-surface-2/50',
      ].join(' ')}
      onClick={() => void handleDialogPick()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-10 w-10 text-ink-faint"
      >
        <path d="m22 8-6 4 6 4V8Z" />
        <rect x="2" y="6" width="14" height="12" rx="2" />
      </svg>
      <p className="text-sm text-ink-muted">
        点击选择视频，或拖拽/粘贴到此处
      </p>
      <p className="text-[11px] text-ink-dim">
        支持 mp4, webm, mov, avi, mkv 等格式
      </p>
    </div>
  )
}
