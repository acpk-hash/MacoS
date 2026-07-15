import { lazy, Suspense, useEffect, useState } from 'react'
import { useSubagentStore } from '../../stores/subagentStore'

const TerminalPane = lazy(() => import('../pi/TerminalPane'))
const SshPanel = lazy(() => import('../pi/SshPanel'))
const SubagentsPanel = lazy(() => import('./SubagentsPanel'))

type BottomTab = 'terminal' | 'subagents' | 'ssh'

export default function BottomPanel({ cwd }: { cwd: string | null }) {
  const runningCount = useSubagentStore((s) => s.agents.filter((a) => a.status === 'running').length)
  const initSubagents = useSubagentStore((s) => s.init)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<BottomTab>('terminal')
  const [termMounted, setTermMounted] = useState(false)
  const [subagentsMounted, setSubagentsMounted] = useState(false)
  const [sshMounted, setSshMounted] = useState(false)

  useEffect(() => {
    void initSubagents()
  }, [initSubagents])

  useEffect(() => {
    if (!open) return
    if (tab === 'terminal' && cwd) setTermMounted(true)
    if (tab === 'subagents') setSubagentsMounted(true)
    if (tab === 'ssh') setSshMounted(true)
  }, [open, tab, cwd])

  const clickTab = (next: BottomTab) => {
    if (open && tab === next) {
      setOpen(false)
      return
    }
    setTab(next)
    setOpen(true)
  }

  const tabCls = (next: BottomTab) =>
    [
      'px-2.5 h-full flex items-center gap-1.5 text-[11px] border-t-2 transition-colors',
      open && tab === next
        ? 'border-primary text-ink bg-surface-2/60'
        : 'border-transparent text-ink-dim hover:text-ink',
    ].join(' ')

  return (
    <div className="flex-shrink-0 border-t border-line bg-surface flex flex-col">
      <div className="flex items-center h-8 px-1 flex-shrink-0 select-none">
        <button onClick={() => clickTab('terminal')} className={tabCls('terminal')}>
          <span aria-hidden="true">▣</span> 终端
        </button>
        <button onClick={() => clickTab('subagents')} className={tabCls('subagents')}>
          <span aria-hidden="true">⫶</span> 子任务
          {runningCount > 0 && (
            <span className="min-w-[16px] h-4 px-1 rounded-full bg-running/20 border border-running/30 text-running text-[10px] leading-4 text-center">
              {runningCount}
            </span>
          )}
        </button>
        <button onClick={() => clickTab('ssh')} className={tabCls('ssh')}>
          <span aria-hidden="true">⇅</span> SSH
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setOpen(!open)}
          className="px-2 text-[11px] text-ink-dim hover:text-ink"
          title={open ? '收起面板' : '展开面板'}
        >
          {open ? '▾' : '▴'}
        </button>
      </div>

      <div
        className={[
          'overflow-hidden transition-[height] duration-150',
          open ? 'h-[280px] border-t border-line' : 'h-0',
        ].join(' ')}
      >
        <div className="h-[280px] min-h-0">
          {termMounted && cwd && (
            <div className={open && tab === 'terminal' ? 'block h-full px-1 py-1' : 'hidden'}>
              <Suspense fallback={null}>
                <TerminalPane cwd={cwd} visible={open && tab === 'terminal'} />
              </Suspense>
            </div>
          )}
          {termMounted === false && open && tab === 'terminal' && !cwd && (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-dim">
              先打开项目文件夹，终端将在项目目录启动
            </div>
          )}
          {subagentsMounted && (
            <div className={open && tab === 'subagents' ? 'block h-full' : 'hidden'}>
              <Suspense fallback={null}>
                <SubagentsPanel />
              </Suspense>
            </div>
          )}
          {sshMounted && (
            <div className={open && tab === 'ssh' ? 'block h-full p-2' : 'hidden'}>
              <Suspense fallback={null}>
                <SshPanel />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
