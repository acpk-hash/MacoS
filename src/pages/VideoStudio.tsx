import { useEffect, useRef, useState } from 'react'
import { useStudioStore } from '../stores/studioStore'
import { useVideoStore } from '../stores/videoStore'
import GeneratePanel from '../components/video/GeneratePanel'
import ProcessPanel from '../components/video/ProcessPanel'
import { Mascot } from '../components/ui'

// 视频工作台 — 双模式 tab：生成(text-to-video) + 处理(核心)。
// 状态全部在 videoStore，离开页面回来完整恢复。

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

export default function VideoStudio() {
  const { loadModels } = useStudioStore()
  const { tab, setTab } = useVideoStore()
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  // 初始加载模型列表。
  useEffect(() => {
    if (!isTauri) return
    loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  const tabCls = (active: boolean) =>
    [
      'px-4 py-1.5 text-sm font-medium rounded-lg transition-colors',
      active
        ? 'bg-surface-2 text-ink border border-line shadow-sm'
        : 'text-ink-muted hover:text-ink hover:bg-surface-2/50',
    ].join(' ')

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧工作台 */}
      <aside className="w-[360px] flex-shrink-0 border-r border-line flex flex-col min-h-0">
        <div className="px-4 pt-5 pb-3 flex-shrink-0">
          <h1 className="text-lg font-bold text-ink">视频</h1>
          <p className="mt-0.5 text-xs text-ink-muted">视频生成与处理工作台</p>
        </div>

        {/* Tab 切换 */}
        <div className="px-4 pb-3 flex-shrink-0 flex gap-1.5">
          <button
            className={tabCls(tab === 'process')}
            onClick={() => setTab('process')}
          >
            处理
          </button>
          <button
            className={tabCls(tab === 'generate')}
            onClick={() => setTab('generate')}
          >
            生成
          </button>
        </div>

        {/* Tab 面板 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          {tab === 'generate' ? (
            <GeneratePanel />
          ) : (
            <ProcessPanel onToast={showToast} />
          )}
        </div>
      </aside>

      {/* 右侧预览/结果区 */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <RightPane onToast={showToast} />
      </section>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg bg-surface-2 border border-line text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}

// 右侧面板：根据 tab 显示不同内容。
function RightPane({ onToast: _onToast }: { onToast: (msg: string) => void }) {
  const { tab, video, tasks } = useVideoStore()

  if (tab === 'generate') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <Mascot size={56} className="mb-4" />
        <h2 className="text-xl font-bold text-ink mb-1">视频生成</h2>
        <p className="text-sm text-ink-dim text-center max-w-md">
          在左侧输入描述并选择模型，生成的视频将出现在此处。
          如果没有可用的视频模型，请先到设置页面添加支持视频生成的服务商。
        </p>
      </div>
    )
  }

  // 处理模式
  if (!video) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <Mascot size={56} className="mb-4" />
        <h2 className="text-xl font-bold text-ink mb-1">视频处理</h2>
        <p className="text-sm text-ink-dim text-center max-w-md">
          在左侧上传视频文件，然后通过 AI 指令进行分析和处理。
          支持生成字幕、内容摘要、剪辑建议等。
        </p>
      </div>
    )
  }

  // 有视频：大预览 + 任务结果
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* 视频大预览 */}
      {video.previewUrl && (
        <div className="px-6 pt-6">
          <div className="rounded-xl overflow-hidden border border-line bg-black max-h-[50vh]">
            <video
              src={video.previewUrl}
              controls
              className="w-full max-h-[50vh] object-contain"
            />
          </div>
          <div className="flex items-center gap-3 mt-2 text-xs text-ink-dim">
            <span className="truncate" title={video.name}>{video.name}</span>
            {video.size > 0 && (
              <span>{(video.size / (1024 * 1024)).toFixed(1)} MB</span>
            )}
            {video.duration != null && (
              <span>
                {Math.floor(video.duration / 60)}:
                {String(Math.round(video.duration % 60)).padStart(2, '0')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 无预览时（大视频）显示信息卡 */}
      {!video.previewUrl && (
        <div className="px-6 pt-6">
          <div className="rounded-xl border border-line bg-surface-2 px-8 py-12 flex flex-col items-center gap-3">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-12 w-12 text-ink-faint"
            >
              <path d="m22 8-6 4 6 4V8Z" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </svg>
            <p className="text-sm text-ink">{video.name}</p>
            <p className="text-xs text-ink-dim">
              视频文件过大，不在此预览。AI 将根据文件元信息进行分析。
            </p>
          </div>
        </div>
      )}

      {/* 任务结果概览（右侧展示所有任务的简要状态） */}
      {tasks.length > 0 && (
        <div className="px-6 py-4">
          <h3 className="text-sm font-medium text-ink mb-3">
            分析任务（{tasks.length}）
          </h3>
          <div className="space-y-2">
            {tasks.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-line bg-surface px-3 py-2 flex items-center gap-2"
              >
                {t.status === 'streaming' && (
                  <span className="w-2 h-2 rounded-full bg-lavender animate-pulse flex-shrink-0" />
                )}
                {t.status === 'done' && (
                  <span className="w-2 h-2 rounded-full bg-mint flex-shrink-0" />
                )}
                {t.status === 'error' && (
                  <span className="w-2 h-2 rounded-full bg-failed flex-shrink-0" />
                )}
                <span className="text-xs text-ink-muted truncate flex-1">
                  {t.instruction}
                </span>
                <span className="text-[11px] text-ink-dim flex-shrink-0">
                  {t.status === 'streaming'
                    ? '分析中...'
                    : t.status === 'done'
                      ? '完成'
                      : '失败'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 空任务提示 */}
      {tasks.length === 0 && (
        <div className="px-6 py-8 flex flex-col items-center">
          <p className="text-sm text-ink-dim text-center">
            视频已加载。在左侧输入分析指令，结果将在此处展示。
          </p>
        </div>
      )}
    </div>
  )
}
