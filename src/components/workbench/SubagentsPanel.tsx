// 子任务面板（P8）：派发并行子 agent 任务、查看各自实时事件流。
// 每个子任务是一个独立 codex 进程，不影响工作台主会话。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSubagentStore, type SubagentStatus, type SubagentEvent } from '../../stores/subagentStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const STATUS_META: Record<SubagentStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: '#5b8cff' },
  done: { label: '完成', color: '#3fb950' },
  error: { label: '出错', color: '#f85149' },
  stopped: { label: '已停止', color: '#8a8a95' },
}

function relTime(ms: number): string {
  const d = Date.now() - ms
  if (d < 0 || !Number.isFinite(d)) return ''
  const s = Math.floor(d / 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function EventLine({ e }: { e: SubagentEvent }) {
  if (e.kind === 'output' && typeof e.text === 'string' && e.text) {
    return <span className="text-ink-muted whitespace-pre-wrap break-words">{e.text}</span>
  }
  if (e.kind === 'tool') {
    const name = e.tool || 'tool'
    const arg = e.cmd || (e.path ? baseName(e.path) : '')
    const bad = e.exit_code != null && e.exit_code !== 0
    return (
      <div>
        <span className="text-sky">{name === 'file_edit' ? '编辑' : name === 'bash' ? '运行' : name}</span>{' '}
        <span className="text-ink-muted">{arg}</span>
        {bad && <span className="text-coral"> (exit {e.exit_code})</span>}
        {typeof e.output === 'string' && e.output.trim() && (
          <pre className="text-ink-dim whitespace-pre-wrap break-words mt-0.5">{e.output}</pre>
        )}
      </div>
    )
  }
  if (e.kind === 'error') {
    return <span className="text-coral whitespace-pre-wrap break-words">{e.message || '出错'}</span>
  }
  if (e.kind === 'done') {
    return <span className="text-mint">— 子任务完成 —</span>
  }
  return null
}

export default function SubagentsPanel() {
  const { agents, eventsById, selectedId, init, spawn, stop, select } = useSubagentStore()
  const currentModel = useWorkbenchStore((s) => s.currentModel)
  const cwd = useWorkspaceStore((s) => (s.remote ? s.localRoot : s.root))

  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void init()
  }, [init])

  const canDispatch = !!currentModel && !!cwd && !!prompt.trim() && !busy

  const events = selectedId ? eventsById[selectedId] ?? [] : []
  // 新事件自动滚到底。
  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length, selectedId])

  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])

  const onDispatch = async () => {
    if (!canDispatch || !cwd || !currentModel) return
    setBusy(true)
    setErr(null)
    try {
      await spawn(prompt.trim(), cwd, currentModel)
      setPrompt('')
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-2">
      {/* 派发区 */}
      <div className="flex-shrink-0">
        <div className="flex items-start gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void onDispatch()
              }
            }}
            rows={2}
            placeholder="派发一个并行子任务，例如：为 utils 目录补单元测试（Ctrl+Enter 派发）"
            className="flex-1 resize-none bg-surface-2 border border-line rounded px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-dim focus:border-sakura outline-none"
          />
          <button
            onClick={() => void onDispatch()}
            disabled={!canDispatch}
            className="flex-shrink-0 px-3 py-1.5 rounded text-[12px] bg-sakura/15 text-sakura border border-sakura/30 hover:bg-sakura/25 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            派发子任务
          </button>
        </div>
        {(!currentModel || !cwd) && (
          <p className="text-[11px] text-ink-dim mt-1">请先打开工作区并选择模型，再派发子任务。</p>
        )}
        {err && <p className="text-[11px] text-coral mt-1">派发失败：{err}</p>}
      </div>

      {/* 主体：左列表 + 右事件流 */}
      <div className="flex-1 min-h-0 flex gap-2">
        {/* 列表 */}
        <div className="w-56 flex-shrink-0 overflow-y-auto border border-line rounded">
          {agents.length === 0 ? (
            <p className="text-[12px] text-ink-dim text-center mt-6 px-2">
              暂无子任务。派发一个即可并行执行。
            </p>
          ) : (
            <div className="flex flex-col">
              {agents.map((a) => {
                const meta = STATUS_META[a.status] ?? STATUS_META.stopped
                return (
                  <button
                    key={a.id}
                    onClick={() => select(a.id)}
                    className={[
                      'text-left px-2.5 py-2 border-b border-line/60 transition-colors',
                      selectedId === a.id ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: meta.color }}
                      />
                      <span className="text-[12px] text-ink truncate">{a.title || '（无标题）'}</span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5 pl-3">
                      <span className="text-[10px]" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                      <span className="text-[10px] text-ink-dim">{relTime(a.started_at)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 事件流 */}
        <div className="flex-1 min-h-0 flex flex-col border border-line rounded">
          {selected ? (
            <>
              <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-line/60 flex-shrink-0">
                <span className="text-[12px] text-ink-muted truncate font-mono">{selected.model}</span>
                {selected.status === 'running' && (
                  <button
                    onClick={() => void stop(selected.id)}
                    className="text-[11px] px-2 py-0.5 rounded text-coral border border-coral/30 hover:bg-coral/10"
                  >
                    停止
                  </button>
                )}
              </div>
              <div ref={streamRef} className="flex-1 min-h-0 overflow-y-auto px-2.5 py-1.5 font-mono text-[12px] leading-relaxed flex flex-col gap-0.5">
                {events.length === 0 ? (
                  <p className="text-ink-dim">等待输出…</p>
                ) : (
                  events.map((e, i) => <EventLine key={i} e={e} />)
                )}
              </div>
            </>
          ) : (
            <p className="text-[12px] text-ink-dim text-center mt-6 px-2">选择左侧一个子任务查看其实时输出。</p>
          )}
        </div>
      </div>
    </div>
  )
}
