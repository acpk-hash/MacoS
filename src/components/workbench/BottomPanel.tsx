// 底部面板（G2b/G2c/P8）— 可折叠标签页：
//   任务（AI 步骤时间线）/ 终端（真交互式 xterm+PTY）/ AI 日志（AI 命令只读
//   输出，保留原功能）/ 规则（工作区 AGENTS.md）/ SSH 远程。
// 终端首次打开后常驻挂载（切走仅 CSS 隐藏），避免切标签杀掉 shell。
import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useSshStore } from '../../stores/sshStore'
import { useSubagentStore } from '../../stores/subagentStore'
import StatusDot from '../ui/StatusDot'
import SshPanel from './SshPanel'
import TerminalPane from './TerminalPane'
import RulesPane from './RulesPane'
import SubagentsPanel from './SubagentsPanel'

export type BottomTab = 'tasks' | 'terminal' | 'ailog' | 'rules' | 'ssh' | 'subagents'

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
  const sshCount = useSshStore((s) => s.conns.length)
  const subRunning = useSubagentStore((s) => s.agents.filter((a) => a.status === 'running').length)
  // 本地 shell 永远起在本地工作根（远程浏览时也不切到 SFTP 根）。
  const localRoot = useWorkspaceStore((s) => (s.remote ? s.localRoot : s.root))

  // 终端懒启动 + 常驻：第一次切到终端标签才建 PTY，之后隐藏不销毁。
  const [termStarted, setTermStarted] = useState(false)
  useEffect(() => {
    if (open && tab === 'terminal' && localRoot) setTermStarted(true)
  }, [open, tab, localRoot])

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
        <span className="text-[10px] px-1.5 rounded-chip bg-surface-2 text-ink-dim">{count}</span>
      )}
    </button>
  )

  const termVisible = open && tab === 'terminal'

  return (
    <div
      className={[
        'flex flex-col glass border-t border-line flex-shrink-0 transition-[height] duration-150',
        open ? 'h-64' : 'h-9',
      ].join(' ')}
    >
      {/* Tab bar */}
      <div className="flex items-center h-9 flex-shrink-0 border-b border-line/60">
        <Tab id="tasks" label="任务" count={steps.length} />
        <Tab id="terminal" label="终端" />
        <Tab id="ailog" label="AI 日志" count={bashes.length} />
        <Tab id="rules" label="规则" />
        <Tab id="subagents" label="子任务" count={subRunning} />
        <Tab id="ssh" label="SSH" count={sshCount} />
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

      {/* 终端：常驻（首次进入后不再卸载，切走仅隐藏；key=root 换目录时重建 PTY） */}
      {termStarted && localRoot && (
        <div
          className={[
            'flex-1 min-h-0 px-2 pt-1.5 pb-1 bg-[#17171b]',
            termVisible ? '' : 'hidden',
          ].join(' ')}
        >
          <TerminalPane key={localRoot} cwd={localRoot} visible={termVisible} />
        </div>
      )}
      {termVisible && !localRoot && (
        <p className="text-[12px] text-ink-dim text-center mt-6">
          请先打开一个本地文件夹，再使用终端。
        </p>
      )}

      {/* 其它标签体 */}
      {open && tab === 'ssh' && (
        <div className="flex-1 min-h-0 px-3 py-2">
          <SshPanel />
        </div>
      )}
      {open && tab === 'rules' && (
        <div className="flex-1 min-h-0 px-3 py-2">
          <RulesPane />
        </div>
      )}
      {open && tab === 'subagents' && (
        <div className="flex-1 min-h-0 px-3 py-2">
          <SubagentsPanel />
        </div>
      )}
      {open && (tab === 'tasks' || tab === 'ailog') && (
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

          {tab === 'ailog' &&
            (bashes.length === 0 ? (
              <p className="text-[12px] text-ink-dim text-center mt-6">暂无 AI 命令输出</p>
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
        </div>
      )}
    </div>
  )
}
