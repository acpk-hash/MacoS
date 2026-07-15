import { useEffect, useMemo, useRef, useState } from 'react'
import { useSubagentStore, type SubagentEvent, type SubagentStatus } from '../../stores/subagentStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const statusText: Record<SubagentStatus, string> = {
  running: '运行中',
  done: '完成',
  error: '出错',
  stopped: '已停止',
}

const statusClass: Record<SubagentStatus, string> = {
  running: 'bg-running/15 text-running border-running/30',
  done: 'bg-mint/15 text-mint border-mint/30',
  error: 'bg-coral/15 text-coral border-coral/30',
  stopped: 'bg-ink-dim/15 text-ink-dim border-line',
}

function relativeTime(ts: number): string {
  const raw = ts > 10_000_000_000 ? ts : ts * 1000
  const diff = Date.now() - raw
  if (!Number.isFinite(diff)) return '刚刚'
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  return `${day} 天前`
}

function clip(text: string, limit = 30_000): string {
  return text.length > limit ? text.slice(0, limit) + '\n……（输出过长，已截断）' : text
}

function EventRow({ event }: { event: SubagentEvent }) {
  const time = new Date(event.ts > 10_000_000_000 ? event.ts : event.ts * 1000).toLocaleTimeString()
  if (event.kind === 'output') {
    return (
      <div className="py-1.5 border-b border-line/50">
        <div className="text-[10px] text-ink-faint mb-0.5">{time} assistant</div>
        <pre className="whitespace-pre-wrap break-words text-ink-muted">{clip(event.text ?? '')}</pre>
      </div>
    )
  }
  if (event.kind === 'tool') {
    const label = event.tool ?? 'tool'
    const target = event.cmd ?? event.path ?? ''
    const exit = event.exit_code == null ? '' : ` exit ${event.exit_code}`
    return (
      <div className="py-1.5 border-b border-line/50">
        <div className="flex items-center gap-2 text-[10px] text-ink-faint mb-0.5">
          <span>{time}</span>
          <span className="text-sky">{label}</span>
          {exit && <span className={event.exit_code === 0 ? 'text-mint' : 'text-coral'}>{exit}</span>}
        </div>
        {target && <div className="text-[11px] text-ink-dim break-all mb-1">{target}</div>}
        {event.diff != null && <pre className="whitespace-pre-wrap break-words text-gold">{clip(String(event.diff))}</pre>}
        {event.output && <pre className="whitespace-pre-wrap break-words text-ink-muted">{clip(event.output)}</pre>}
      </div>
    )
  }
  if (event.kind === 'error') {
    return (
      <div className="py-1.5 border-b border-line/50">
        <div className="text-[10px] text-coral/80 mb-0.5">{time} error</div>
        <pre className="whitespace-pre-wrap break-words text-coral">{clip(event.message ?? event.text ?? '子任务出错')}</pre>
      </div>
    )
  }
  if (event.kind === 'done') {
    return (
      <div className="py-1.5 border-b border-line/50 text-mint">
        <span className="text-[10px] text-ink-faint mr-2">{time}</span>子任务完成
      </div>
    )
  }
  return (
    <div className="py-1.5 border-b border-line/50">
      <div className="text-[10px] text-ink-faint mb-0.5">{time} {event.kind}</div>
      <pre className="whitespace-pre-wrap break-words text-ink-muted">{clip(JSON.stringify(event, null, 2))}</pre>
    </div>
  )
}

export default function SubagentsPanel() {
  const agents = useSubagentStore((s) => s.agents)
  const eventsById = useSubagentStore((s) => s.eventsById)
  const selectedId = useSubagentStore((s) => s.selectedId)
  const init = useSubagentStore((s) => s.init)
  const refresh = useSubagentStore((s) => s.refresh)
  const spawn = useSubagentStore((s) => s.spawn)
  const stop = useSubagentStore((s) => s.stop)
  const select = useSubagentStore((s) => s.select)
  const model = useWorkbenchStore((s) => s.currentModel)
  const root = useWorkspaceStore((s) => s.root)
  const localRoot = useWorkspaceStore((s) => s.localRoot)
  const cwd = localRoot ?? root
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? agents[0] ?? null,
    [agents, selectedId],
  )
  const events = selected ? eventsById[selected.id] ?? [] : []
  const canSpawn = !!prompt.trim() && !!cwd && !!model && !busy

  useEffect(() => {
    void init()
    void refresh()
  }, [init, refresh])

  useEffect(() => {
    if (!selectedId && agents[0]) select(agents[0].id)
  }, [agents, selectedId, select])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length, selected?.id])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = prompt.trim()
    if (!body || !cwd || !model || busy) return
    setBusy(true)
    try {
      await spawn(body, cwd, model)
      setPrompt('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-surface text-ink">
      <form onSubmit={submit} className="flex-shrink-0 border-b border-line p-2 flex gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="派发一个并行子任务,例如:为 utils 目录补单元测试"
          className="flex-1 min-h-[56px] max-h-[120px] resize-none rounded-card border border-line bg-surface-2 px-2.5 py-2 text-[12.5px] text-ink placeholder:text-ink-faint outline-none focus:border-primary/60 disabled:opacity-50"
          disabled={!cwd || !model || busy}
        />
        <div className="w-[132px] flex flex-col gap-1.5">
          <button
            type="submit"
            disabled={!canSpawn}
            className="h-8 rounded-btn bg-primary hover:bg-primary-hover disabled:opacity-30 disabled:pointer-events-none text-[12px] text-white transition-colors"
          >
            派发子任务
          </button>
          {(!cwd || !model) && (
            <div className="text-[10.5px] leading-4 text-coral">请先打开工作区并选择模型</div>
          )}
        </div>
      </form>

      <div className="flex-1 min-h-0 grid grid-cols-[260px_minmax(0,1fr)]">
        <div className="border-r border-line min-h-0 overflow-y-auto p-2">
          {agents.length === 0 ? (
            <div className="mt-8 px-3 text-center text-[12px] text-ink-dim leading-5 select-none">
              暂无子任务。派发一个任务后，可在这里查看并行执行状态。
            </div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => select(agent.id)}
                className={[
                  'w-full text-left rounded-btn px-2 py-2 mb-1 border transition-colors group',
                  selected?.id === agent.id
                    ? 'bg-primary-tint border-primary/35 text-ink'
                    : 'bg-transparent border-transparent hover:bg-surface-2 text-ink-muted',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate text-[12px]" title={agent.title}>{agent.title}</span>
                  <span className={`flex-shrink-0 rounded-chip border px-1.5 py-0.5 text-[10px] ${statusClass[agent.status]}`}>
                    {statusText[agent.status]}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-faint">
                  <span>{relativeTime(agent.started_at)}</span>
                  <span className="truncate font-mono" title={agent.model}>{agent.model}</span>
                </div>
                {agent.status === 'running' && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      void stop(agent.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation()
                        void stop(agent.id)
                      }
                    }}
                    className="mt-1.5 inline-flex px-2 py-0.5 rounded-btn border border-coral/30 text-[10.5px] text-coral hover:bg-coral/10"
                  >
                    停止
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="min-h-0 flex flex-col">
          {selected ? (
            <>
              <div className="flex-shrink-0 h-8 border-b border-line px-3 flex items-center gap-2">
                <span className="text-[12px] text-ink truncate">{selected.title}</span>
                <span className={`rounded-chip border px-1.5 py-0.5 text-[10px] ${statusClass[selected.status]}`}>
                  {statusText[selected.status]}
                </span>
                <span className="ml-auto text-[10.5px] text-ink-faint font-mono truncate">{selected.cwd}</span>
              </div>
              <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
                {events.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-[12px] text-ink-dim select-none">
                    等待子任务输出…
                  </div>
                ) : (
                  events.map((event, idx) => <EventRow key={`${event.id}-${event.ts}-${idx}`} event={event} />)
                )}
              </div>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-dim select-none">
              选择一个子任务查看事件流
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
