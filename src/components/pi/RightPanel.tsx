// /pi 右栏（~300px，可折叠）：会话信息 + 改动文件列表。
// 文件树 / diff 视图深化留下一阶段（本组件即为其挂载位）。
import { useMemo } from 'react'
import { usePiStore, type PiTimelineItem, type PiUsage } from '../../stores/piStore'

const EMPTY_ITEMS: PiTimelineItem[] = []

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  idle: { text: '就绪', cls: 'text-ink-dim' },
  running: { text: '运行中', cls: 'text-running' },
  done: { text: '已完成', cls: 'text-mint' },
  error: { text: '出错', cls: 'text-coral' },
}

function InfoRow({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 text-[11.5px]">
      <span className="text-ink-dim flex-shrink-0">{k}</span>
      <span className="text-ink text-right min-w-0 truncate" title={title}>
        {v}
      </span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5 border-b border-line">
      <div className="text-[10.5px] text-ink-faint uppercase tracking-wider mb-1.5 select-none">
        {title}
      </div>
      {children}
    </div>
  )
}

/** 从 tool 条目里抽 edit/write 的目标路径（去重，后触碰的排前面标记生效）。 */
function collectTouchedFiles(
  items: PiTimelineItem[],
): Array<{ path: string; kind: 'edit' | 'write' }> {
  const map = new Map<string, 'edit' | 'write'>()
  for (const it of items) {
    if (it.kind !== 'tool') continue
    if (it.toolName !== 'edit' && it.toolName !== 'write') continue
    const args = it.args
    if (!args || typeof args !== 'object') continue
    const a = args as Record<string, unknown>
    const path =
      typeof a.path === 'string'
        ? a.path
        : typeof a.file_path === 'string'
          ? a.file_path
          : typeof a.filePath === 'string'
            ? a.filePath
            : null
    if (!path) continue
    map.set(path, it.toolName)
  }
  return Array.from(map, ([path, kind]) => ({ path, kind }))
}

export default function RightPanel() {
  const session = usePiStore((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId) ?? null,
  )
  const usage = usePiStore((s) =>
    s.activeSessionId ? s.usageById[s.activeSessionId] ?? null : null,
  )
  const items = usePiStore((s) =>
    s.activeSessionId ? s.timelineById[s.activeSessionId] ?? EMPTY_ITEMS : EMPTY_ITEMS,
  )

  const files = useMemo(() => collectTouchedFiles(items), [items])

  if (!session) {
    return (
      <div className="w-[300px] flex-shrink-0 h-full bg-surface border-l border-line flex items-center justify-center">
        <span className="text-[11.5px] text-ink-faint select-none">暂无会话</span>
      </div>
    )
  }

  const st = STATUS_LABEL[session.status] ?? STATUS_LABEL.idle
  const u: PiUsage | null = usage

  return (
    <div className="w-[300px] flex-shrink-0 h-full bg-surface border-l border-line flex flex-col overflow-y-auto">
      <Section title="会话信息">
        <InfoRow k="目录" v={baseName(session.cwd)} title={session.cwd} />
        <InfoRow k="模型" v={session.model || '默认'} title={session.model} />
        <InfoRow k="状态" v={<span className={st.cls}>{st.text}</span>} />
      </Section>

      <Section title="用量累计">
        {u && u.turns > 0 ? (
          <>
            <InfoRow k="输入 tokens" v={fmt(u.input)} />
            <InfoRow k="输出 tokens" v={fmt(u.output)} />
            {(u.cacheRead > 0 || u.cacheWrite > 0) && (
              <InfoRow k="缓存 读/写" v={`${fmt(u.cacheRead)} / ${fmt(u.cacheWrite)}`} />
            )}
            {u.cost > 0 && <InfoRow k="费用" v={`$${u.cost.toFixed(4)}`} />}
            <InfoRow k="回合" v={String(u.turns)} />
          </>
        ) : (
          <div className="text-[11.5px] text-ink-faint py-1 select-none">暂无用量数据</div>
        )}
      </Section>

      <Section title={`改动文件${files.length > 0 ? ` · ${files.length}` : ''}`}>
        {files.length === 0 ? (
          <div className="text-[11.5px] text-ink-faint py-1 select-none">
            agent 改动的文件会列在这里
          </div>
        ) : (
          <div className="space-y-0.5">
            {files.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-2 px-1.5 py-1 rounded-btn hover:bg-surface-2 text-[11.5px]"
                title={f.path}
              >
                <span
                  className={f.kind === 'write' ? 'text-mint' : 'text-gold'}
                  aria-hidden="true"
                >
                  {f.kind === 'write' ? '＋' : '✎'}
                </span>
                <span className="text-ink-muted truncate font-mono">{baseName(f.path)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 下一阶段：文件树 / diff 视图挂载位 */}
      <div className="px-3 py-2.5 text-[10.5px] text-ink-faint select-none">
        diff 视图与文件树将在下一阶段加入
      </div>
    </div>
  )
}
