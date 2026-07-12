// 底部全局任务条：消费 taskRegistryStore，跨板块显示后台 agent 任务。
// 常态是一条细条上的徽章「▶ 运行中 N 个任务」；点击向上弹出任务明细浮层
// （板块 chip · 标题 · 状态点 · detail · 相对时间），可一键清除已完成。
import { useEffect, useRef, useState } from 'react'
import {
  MODULE_LABEL,
  useRunningTaskCount,
  useTaskRegistry,
  type GlobalTaskStatus,
  type TaskModule,
} from '../stores/taskRegistryStore'

/** 板块 chip 配色（白色主题下的浅底深字）。 */
const MODULE_CHIP: Record<TaskModule, string> = {
  coding: 'bg-primary-tint text-primary',
  office: 'bg-blue-50 text-blue-600',
  image: 'bg-purple-50 text-purple-600',
  science: 'bg-emerald-50 text-emerald-600',
  auto: 'bg-amber-50 text-amber-600',
  commerce: 'bg-rose-50 text-rose-600',
  video: 'bg-indigo-50 text-indigo-600',
  mcp: 'bg-cyan-50 text-cyan-600',
  hooks: 'bg-teal-50 text-teal-600',
}

const STATUS_DOT: Record<GlobalTaskStatus, string> = {
  running: 'bg-running animate-pulse',
  done: 'bg-done',
  error: 'bg-failed',
}

const STATUS_TEXT: Record<GlobalTaskStatus, string> = {
  running: '运行中',
  done: '已完成',
  error: '失败',
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  return Math.floor(diff / 86_400_000) + ' 天前'
}

export default function GlobalTaskBar() {
  const tasks = useTaskRegistry((s) => s.tasks)
  const clearFinished = useTaskRegistry((s) => s.clearFinished)
  const running = useRunningTaskCount()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击浮层外部关闭。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const finishedCount = tasks.length - running

  return (
    <div
      ref={rootRef}
      className="relative flex items-center h-7 px-2 bg-bg border-t border-line flex-shrink-0 select-none"
    >
      {/* 徽章：运行数入口 */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="全局任务列表"
        className={
          'flex items-center gap-1.5 h-5 px-2 rounded-btn text-[11px] leading-none transition-colors ' +
          (running > 0
            ? 'text-ink font-medium hover:bg-surface-2'
            : 'text-ink-faint hover:bg-surface-2 hover:text-ink-dim')
        }
      >
        <span aria-hidden="true" className="text-[9px]">▶</span>
        {running > 0 ? `运行中 ${running} 个任务` : '无运行任务'}
        {finishedCount > 0 && (
          <span className="text-ink-dim">· {finishedCount} 已结束</span>
        )}
      </button>

      {/* 向上浮层：任务明细 */}
      {open && (
        <div
          className="absolute bottom-full left-2 mb-1.5 w-[380px] max-h-72 flex flex-col
                     bg-white border border-line rounded-md shadow-lg z-50 overflow-hidden"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-line">
            <span className="text-xs font-semibold text-ink">全局任务</span>
            <button
              onClick={clearFinished}
              disabled={finishedCount === 0}
              className={
                'text-[11px] transition-colors ' +
                (finishedCount > 0
                  ? 'text-primary hover:text-primary-hover'
                  : 'text-ink-faint cursor-default')
              }
            >
              清除已完成
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {tasks.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-ink-dim">暂无任务</p>
            ) : (
              tasks
                .slice()
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0"
                  >
                    <span
                      className={
                        'flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] leading-none font-medium ' +
                        MODULE_CHIP[t.module]
                      }
                    >
                      {MODULE_LABEL[t.module]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-ink truncate" title={t.title}>
                        {t.title}
                      </p>
                      {t.detail && (
                        <p className="text-[11px] text-ink-dim truncate" title={t.detail}>
                          {t.detail}
                        </p>
                      )}
                    </div>
                    <span
                      aria-hidden="true"
                      className={
                        'flex-shrink-0 inline-block w-1.5 h-1.5 rounded-full ' + STATUS_DOT[t.status]
                      }
                      title={STATUS_TEXT[t.status]}
                    />
                    <span className="flex-shrink-0 text-[10px] text-ink-faint">
                      {relTime(t.updatedAt)}
                    </span>
                  </div>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
