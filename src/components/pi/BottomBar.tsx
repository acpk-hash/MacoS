// PiShell 底部可折叠面板（④⑤）：IDE 式底部条，tab =「终端」「SSH」。
// 终端 = 历史 workbench/TerminalPane 恢复件（xterm + pty_* 命令，cwd 跟随会话）；
// SSH = 历史 workbench/SshPanel 恢复件（ssh_* 命令）。
// 面板首次展开才挂载对应内容；此后保持挂载（display 切换），终端会话不丢。
import { lazy, Suspense, useEffect, useState } from 'react'
import { usePiStore } from '../../stores/piStore'

// xterm / ssh 面板都不小且非首屏必需：懒加载成独立 chunk。
const TerminalPane = lazy(() => import('./TerminalPane'))
const SshPanel = lazy(() => import('./SshPanel'))

export default function BottomBar({ cwd }: { cwd: string | null }) {
  const open = usePiStore((s) => s.bottomOpen)
  const tab = usePiStore((s) => s.bottomTab)
  const setOpen = usePiStore((s) => s.setBottomOpen)
  const setTab = usePiStore((s) => s.setBottomTab)

  // 首次展开过的 tab 才挂载（懒加载 xterm / ssh 面板），之后常驻。
  const [termMounted, setTermMounted] = useState(false)
  const [sshMounted, setSshMounted] = useState(false)
  useEffect(() => {
    if (!open) return
    if (tab === 'terminal' && cwd) setTermMounted(true)
    if (tab === 'ssh') setSshMounted(true)
  }, [open, tab, cwd])

  const clickTab = (t: 'terminal' | 'ssh') => {
    if (open && tab === t) {
      setOpen(false)
      return
    }
    setTab(t)
    setOpen(true)
  }

  const tabCls = (t: 'terminal' | 'ssh') =>
    [
      'px-2.5 h-full flex items-center gap-1.5 text-[11px] border-t-2 transition-colors',
      open && tab === t
        ? 'border-primary text-ink bg-surface-2/60'
        : 'border-transparent text-ink-dim hover:text-ink',
    ].join(' ')

  return (
    <div className="flex-shrink-0 border-t border-line bg-surface flex flex-col">
      {/* tab 条 */}
      <div className="flex items-center h-8 px-1 flex-shrink-0 select-none">
        <button onClick={() => clickTab('terminal')} className={tabCls('terminal')}>
          <span aria-hidden="true">▣</span> 终端
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

      {/* 内容区：收起时高度归零但保持挂载（终端会话/SSH 连接不丢） */}
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
