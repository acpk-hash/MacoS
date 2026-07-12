// /pi 中栏底部 Composer：多行输入（Enter 发送 / Shift+Enter 换行）、
// 运行中显示「排队 N 条」徽章与「停止」按钮。
import { useRef, useState } from 'react'
import { usePiStore } from '../../stores/piStore'

const EMPTY_QUEUE: string[] = []

export default function PiComposer() {
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const activeSessionId = usePiStore((s) => s.activeSessionId)
  const status = usePiStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
  )
  const queue = usePiStore((s) =>
    s.activeSessionId ? s.composerQueue[s.activeSessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE,
  )
  const send = usePiStore((s) => s.send)
  const abort = usePiStore((s) => s.abort)

  const running = status === 'running'
  const disabled = !activeSessionId

  const doSend = () => {
    const body = draft.trim()
    if (!body || disabled) return
    setDraft('')
    void send(body)
    // 高度复位
    const el = taRef.current
    if (el) el.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      doSend()
    }
  }

  // 简易自适应高度（1~10 行）。
  const onInput = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }

  return (
    <div className="flex-shrink-0 border-t border-line px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="rounded-card border border-line bg-surface focus-within:border-primary/60 transition-colors">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onInput={onInput}
            rows={2}
            disabled={disabled}
            placeholder={
              disabled
                ? '先新建一个会话'
                : running
                  ? '输入插话内容，Enter 发送（运行中会先排队投递）'
                  : '交代一个任务，Enter 发送，Shift+Enter 换行'
            }
            className="w-full bg-transparent resize-none px-3 pt-2.5 pb-1 text-[13.5px] text-ink placeholder:text-ink-faint outline-none max-h-[220px] disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <span className="text-[10.5px] text-ink-faint select-none">
              Enter 发送 · Shift+Enter 换行
            </span>
            <div className="flex-1" />
            {queue.length > 0 && (
              <span
                className="text-[10.5px] px-2 py-0.5 rounded-chip bg-gold/15 text-gold border border-gold/25"
                title={queue.map((q, i) => `${i + 1}. ${q}`).join('\n')}
              >
                排队 {queue.length} 条
              </span>
            )}
            {running && (
              <button
                onClick={() => void abort()}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-btn bg-surface-2 hover:bg-coral/15 border border-line hover:border-coral/30 text-[11.5px] text-ink-muted hover:text-coral transition-colors"
                title="停止当前任务"
              >
                <span className="w-2 h-2 bg-current rounded-[2px]" />
                停止
              </button>
            )}
            <button
              onClick={doSend}
              disabled={disabled || !draft.trim()}
              className="px-3 py-1 rounded-btn bg-primary hover:bg-primary-hover disabled:opacity-30 disabled:pointer-events-none text-[11.5px] text-white transition-colors"
              title={running ? '发送插话（排队投递）' : '发送'}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
