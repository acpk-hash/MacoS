// /pi 左栏（~240px）：打开项目 / 新会话 / 会话列表 / 底部项目路径。
import { usePiStore, type PiSession } from '../../stores/piStore'

function baseName(p: string): string {
  const parts = p.split(/[\/]/)
  return parts[parts.length - 1] || p
}

/** 状态点：running 呼吸、error 红、done 绿、idle 灰。 */
function StatusDot({ status }: { status: PiSession['status'] }) {
  const cls =
    status === 'running'
      ? 'bg-running animate-pulse'
      : status === 'error'
        ? 'bg-coral'
        : status === 'done'
          ? 'bg-mint'
          : 'bg-ink-faint'
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cls}`} />
}

export async function pickProjectDir(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, multiple: false })
    return typeof picked === 'string' ? picked : null
  } catch {
    return null
  }
}

export default function SessionList({
  canCreate,
  onNewSession,
}: {
  canCreate: boolean
  onNewSession: () => void
}) {
  const cwd = usePiStore((s) => s.cwd)
  const setCwd = usePiStore((s) => s.setCwd)
  const sessions = usePiStore((s) => s.sessions)
  const activeSessionId = usePiStore((s) => s.activeSessionId)
  const select = usePiStore((s) => s.select)
  const closeSession = usePiStore((s) => s.closeSession)

  const openProject = async () => {
    const dir = await pickProjectDir()
    if (dir) setCwd(dir)
  }

  return (
    <div className="w-[240px] flex-shrink-0 flex flex-col h-full bg-surface border-r border-line">
      {/* 顶部操作 */}
      <div className="p-2.5 space-y-1.5 flex-shrink-0">
        <button
          onClick={() => void openProject()}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-btn border border-line bg-surface-2/60 hover:bg-surface-2 text-[12px] text-ink-muted hover:text-ink transition-colors"
          title={cwd ? `当前：${cwd}（点击更换）` : '选择一个项目文件夹'}
        >
          <span className="text-gold" aria-hidden="true">▤</span>
          <span className="truncate">{cwd ? baseName(cwd) : '打开项目'}</span>
        </button>
        <button
          onClick={onNewSession}
          disabled={!canCreate}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-btn bg-primary hover:bg-primary-hover disabled:opacity-40 disabled:pointer-events-none text-[12px] text-white transition-colors"
          title={canCreate ? '在当前项目里开一个新会话' : '先打开项目文件夹'}
        >
          <span aria-hidden="true">＋</span>
          <span>新会话</span>
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-1.5">
        {sessions.length === 0 ? (
          <div className="mt-6 px-2 text-center text-[11px] text-ink-faint leading-5 select-none">
            还没有会话
          </div>
        ) : (
          sessions.map((sess) => {
            const active = sess.id === activeSessionId
            return (
              <div
                key={sess.id}
                onClick={() => select(sess.id)}
                className={[
                  'group flex items-center gap-2 px-2 py-1.5 mb-0.5 rounded-btn cursor-pointer transition-colors',
                  active
                    ? 'bg-primary-tint text-ink'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                ].join(' ')}
                title={`${sess.title}\n${sess.cwd}${sess.model ? `\n${sess.model}` : ''}`}
              >
                <StatusDot status={sess.status} />
                <span className="flex-1 min-w-0 truncate text-[12px]">{sess.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeSession(sess.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-ink-dim hover:text-coral text-[11px] px-0.5 transition-opacity"
                  title="关闭会话"
                >
                  ✕
                </button>
              </div>
            )
          })
        )}
      </div>

      {/* 底部：当前项目路径 */}
      {cwd && (
        <div
          className="flex-shrink-0 px-3 py-2 border-t border-line text-[10.5px] text-ink-faint font-mono truncate select-none"
          title={cwd}
        >
          {cwd}
        </div>
      )}
    </div>
  )
}
