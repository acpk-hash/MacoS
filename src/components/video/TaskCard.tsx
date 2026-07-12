import { useVideoStore, type ProcessTask } from '../../stores/videoStore'
import MarkdownLite from '../ui/MarkdownLite'

// 处理任务卡片：流式展示模型回复 + 导出操作。

function Spinner() {
  return (
    <span className="inline-block w-4 h-4 rounded-full border-2 border-line border-t-blue-400 animate-spin" />
  )
}

interface Props {
  task: ProcessTask
}

export default function TaskCard({ task }: Props) {
  const { stopTask, removeTask, exportResult } = useVideoStore()

  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-ink-dim truncate" title={task.instruction}>
            {task.instruction}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {task.status === 'streaming' && (
            <>
              <Spinner />
              <button
                onClick={() => void stopTask(task.id)}
                className="text-[11px] px-2 py-0.5 rounded bg-surface-2 border border-line text-ink-muted hover:text-failed hover:border-failed transition-colors"
              >
                停止
              </button>
            </>
          )}
          {task.status === 'done' && (
            <span className="text-[11px] text-mint font-medium">完成</span>
          )}
          {task.status === 'error' && (
            <span className="text-[11px] text-failed font-medium">失败</span>
          )}
        </div>
      </div>

      {/* Reply content */}
      {task.reply && (
        <div className="max-h-[300px] overflow-y-auto border-t border-line pt-2">
          <MarkdownLite text={task.reply} />
          {task.status === 'streaming' && (
            <span className="inline-block w-1.5 h-4 bg-lavender animate-pulse ml-0.5 align-text-bottom" />
          )}
        </div>
      )}

      {/* Actions */}
      {task.status !== 'streaming' && (
        <div className="flex items-center gap-2 pt-1 border-t border-line">
          {task.status === 'done' && task.reply && (
            <>
              <button
                onClick={() => void exportResult(task.id, 'md')}
                className="text-[11px] px-2 py-1 rounded bg-surface-2 border border-line text-ink-muted hover:text-ink hover:bg-elevated transition-colors"
              >
                导出 .md
              </button>
              <button
                onClick={() => void exportResult(task.id, 'srt')}
                className="text-[11px] px-2 py-1 rounded bg-surface-2 border border-line text-ink-muted hover:text-ink hover:bg-elevated transition-colors"
              >
                导出 .srt
              </button>
              <button
                onClick={() => void exportResult(task.id, 'txt')}
                className="text-[11px] px-2 py-1 rounded bg-surface-2 border border-line text-ink-muted hover:text-ink hover:bg-elevated transition-colors"
              >
                导出 .txt
              </button>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(task.reply)
                  } catch { /* ignore */ }
                }}
                className="text-[11px] px-2 py-1 rounded bg-surface-2 border border-line text-ink-muted hover:text-ink hover:bg-elevated transition-colors"
              >
                复制
              </button>
            </>
          )}
          <div className="flex-1" />
          <button
            onClick={() => removeTask(task.id)}
            className="text-[11px] px-2 py-1 rounded text-ink-dim hover:text-failed transition-colors"
          >
            移除
          </button>
        </div>
      )}
    </div>
  )
}
