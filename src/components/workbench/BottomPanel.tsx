// 底部面板（G2b）— 可折叠标签页：任务时间线 / 终端输出 / SSH 占位(G2c)。
// 只读日志视图，不是可交互 shell。
import { useMemo } from 'react'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import StatusDot from '../ui/StatusDot'

export type BottomTab = 'tasks' | 'terminal' | 'ssh'

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export default function BottomPanel({
  open,
  tab,
  onTab,
  onToggle,
}: {
  open: boolean
  tab: BottomTab
  onTab: (t: BottomTab) => void
  onToggle: () => void
}) {
  const entries = useWorkbenchStore((s) => s.entries)
  const running = useWorkbenchStore((s) => s.running)

  const steps = useMemo(
    () =>
      entries.filter(
        (e) => e.kind === 'tool_bash' || e.kind === 'tool_edit' || e.kind === 'tool_write',
      ),
    [entries],
  )
  const bashes = useMemo(
    () => entries.filter((e): e is Extract<typeof e, { kind: 'tool_bash' }> => e.kind === 'tool_bash'),
    [entries],
  )

  const Tab = ({ id, label, count }: { id: BottomTab; label: string; count?: number }) => (
    <button
      onClick={() => {
        if (!open) onToggle()
        onTab(id)
      }}
      className={[
        'flex items-center gap-1.5 px-3 h-full text-[12px] transition-colors border-b-2',
        open && tab === id
          ? 'text-ink border-sakura'
          : 'text-ink-muted border-transparent hover:text-ink',
      ].join(' ')}
    >
      {label}
      {count != null && count > 0 && (
        <span className="text-[10px] px-1.5 rounded-chip bg-white/8 text-ink-dim">{count}</span>
      )}
    </button>
  )

  return (
    <div
      className={[
        'flex flex-col glass border-t border-line flex-shrink-0 transition-[height] duration-150',
        open ? 'h-52' : 'h-9',
      ].join(' ')}
    >
      {/* Tab bar */}
      <div className="flex items-center h-9 flex-shrink-0 border-b border-line/60">
        <Tab id="tasks" label="任务" count={steps.length} />
        <Tab id="terminal" label="终端输出" count={bashes.length} />
        <Tab id="ssh" label="SSH" />
        <div className="flex-1" />
        {running && (
          <span className="flex items-center gap-1.5 text-[11px] text-lavender mr-3">
            <StatusDot status="running" size={7} pulse />
            运行中
          </span>
        )}
        <button
          onClick={onToggle}
          className="px-3 h-full text-[12px] text-ink-dim hover:text-ink"
          title={open ? '收起面板' : '展开面板'}
        >
          {open ? '▾' : '▴'}
        </button>
      </div>

      {/* Body */}
      {open && (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {tab === 'tasks' &&
            (steps.length === 0 ? (
              <p className="text-[12px] text-ink-dim text-center mt-6">暂无任务步骤</p>
            ) : (
              <div className="flex flex-col gap-1">
                {steps.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-2 text-[12px]">
                    <span className="text-ink-dim w-5 text-right">{i + 1}</span>
                    {s.kind === 'tool_bash' && (
                      <>
                        <StatusDot
                          status={s.exitCode == null || s.exitCode === 0 ? 'done' : 'failed'}
                          size={7}
                        />
                        <span className="text-sky">运行</span>
                        <span className="text-ink-muted font-mono truncate">{s.cmd}</span>
                      </>
                    )}
                    {s.kind === 'tool_edit' && (
                      <>
                        <StatusDot status="done" size={7} />
                        <span className="text-gold">编辑</span>
                        <span className="text-ink-muted font-mono truncate">{baseName(s.path)}</span>
                      </>
                    )}
                    {s.kind === 'tool_write' && (
                      <>
                        <StatusDot status="done" size={7} />
                        <span className="text-mint">新建</span>
                        <span className="text-ink-muted font-mono truncate">{baseName(s.path)}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}

          {tab === 'terminal' &&
            (bashes.length === 0 ? (
              <p className="text-[12px] text-ink-dim text-center mt-6">暂无命令输出</p>
            ) : (
              <div className="font-mono text-[12px] leading-relaxed">
                {bashes.map((b) => (
                  <div key={b.id} className="mb-2">
                    <div className="text-mint">
                      <span className="text-ink-dim">$ </span>
                      {b.cmd}
                      {b.exitCode != null && b.exitCode !== 0 && (
                        <span className="text-coral"> (exit {b.exitCode})</span>
                      )}
                    </div>
                    {b.output.trim() && (
                      <pre className="text-ink-muted whitespace-pre-wrap break-words mt-0.5">
                        {b.output}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            ))}

          {tab === 'ssh' && (
            <div className="flex flex-col items-center justify-center h-full gap-1.5 text-center">
              <div className="text-2xl">🔌</div>
              <p className="text-[12px] text-ink-muted">SSH 远程会话</p>
              <p className="text-[11px] text-ink-dim">将在 G2c 接入（远程主机 / 终端）</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
