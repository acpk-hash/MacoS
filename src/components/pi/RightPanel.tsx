// /pi 右栏（①）：tab 式——「文件」（默认，文件树 + 预览）+「会话信息」。
// 「文件」tab = FilesPanel（workspaceStore 数据源，会话打开时 ws_open_folder(cwd)
// 由 PiShell 初始化）；「会话信息」保留原会话/用量/改动文件区块，改动文件行
// 可点 → openFileInPanel 在「文件」tab 中定位预览。
import { lazy, Suspense, useMemo, useState } from 'react'
import { usePiStore, type PiTimelineItem, type PiUsage } from '../../stores/piStore'

// FilesPanel → workspaceStore → monacoSetup（monaco 大依赖）：懒加载成独立 chunk。
const FilesPanel = lazy(() => import('./FilesPanel'))

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

interface TouchedPiFile {
  path: string
  kind: 'edit' | 'write'
  diff: string
  plus: number
  minus: number
}

function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  return typeof a.path === 'string'
    ? a.path
    : typeof a.file_path === 'string'
      ? a.file_path
      : typeof a.filePath === 'string'
        ? a.filePath
        : null
}

function diffFromTool(it: Extract<PiTimelineItem, { kind: 'tool' }>): string {
  const args = it.args && typeof it.args === 'object' ? it.args as Record<string, unknown> : {}
  if (typeof args.diff === 'string') return args.diff
  if (typeof it.result === 'string') {
    const trimmed = it.result.trim()
    if (trimmed.includes('\n+') || trimmed.includes('\n-') || trimmed.startsWith('---')) return trimmed
  }
  if (it.toolName === 'edit') {
    const edits = Array.isArray(args.edits) ? args.edits : null
    if (edits) {
      const chunks: string[] = []
      for (const e of edits) {
        if (!e || typeof e !== 'object') continue
        const row = e as Record<string, unknown>
        const oldText = typeof row.oldText === 'string' ? row.oldText : typeof row.old_text === 'string' ? row.old_text : ''
        const newText = typeof row.newText === 'string' ? row.newText : typeof row.new_text === 'string' ? row.new_text : ''
        if (!oldText && !newText) continue
        chunks.push([
          '@@ edit @@',
          ...oldText.split(/\r?\n/).filter(Boolean).map((line) => '-' + line),
          ...newText.split(/\r?\n/).filter(Boolean).map((line) => '+' + line),
        ].join('\n'))
      }
      return chunks.join('\n')
    }
    const oldText = typeof args.oldText === 'string' ? args.oldText : typeof args.old_text === 'string' ? args.old_text : ''
    const newText = typeof args.newText === 'string' ? args.newText : typeof args.new_text === 'string' ? args.new_text : ''
    if (oldText || newText) {
      return [
        '@@ edit @@',
        ...oldText.split(/\r?\n/).filter(Boolean).map((line) => '-' + line),
        ...newText.split(/\r?\n/).filter(Boolean).map((line) => '+' + line),
      ].join('\n')
    }
  }
  if (it.toolName === 'write') {
    const content = typeof args.content === 'string' ? args.content : ''
    if (content) return ['@@ write @@', ...content.split(/\r?\n/).slice(0, 200).map((line) => '+' + line)].join('\n')
  }
  return ''
}

function countDiff(diff: string): { plus: number; minus: number } {
  let plus = 0
  let minus = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) plus++
    else if (line.startsWith('-')) minus++
  }
  return { plus, minus }
}

/** 从 tool 条目里抽 edit/write 的目标路径（去重，后触碰的排前面标记生效）。 */
function collectTouchedFiles(items: PiTimelineItem[]): TouchedPiFile[] {
  const map = new Map<string, TouchedPiFile>()
  for (const it of items) {
    if (it.kind !== 'tool') continue
    if (it.toolName !== 'edit' && it.toolName !== 'write') continue
    const path = pathFromArgs(it.args)
    if (!path) continue
    const diff = diffFromTool(it)
    const counts = countDiff(diff)
    map.delete(path)
    map.set(path, { path, kind: it.toolName, diff, plus: counts.plus, minus: counts.minus })
  }
  return Array.from(map.values()).reverse()
}

function DiffPreview({ file }: { file: TouchedPiFile | null }) {
  if (!file) {
    return <div className="text-[11.5px] text-ink-faint py-2 select-none">选择一个改动文件查看 +/- 明细</div>
  }
  const lines = file.diff ? file.diff.split(/\r?\n/).slice(0, 240) : []
  if (lines.length === 0) {
    return <div className="text-[11.5px] text-ink-faint py-2 select-none">该工具事件未返回可展示的 diff</div>
  }
  return (
    <div className="mt-2 rounded-card border border-line bg-editor overflow-hidden">
      <div className="px-2 py-1 border-b border-line text-[10.5px] font-mono text-ink-faint truncate" title={file.path}>
        {file.path}
      </div>
      <pre className="max-h-72 overflow-auto p-2 text-[10.5px] leading-5 font-mono whitespace-pre-wrap">
        {lines.map((line, i) => {
          const cls = line.startsWith('+') && !line.startsWith('+++')
            ? 'text-done bg-done/10'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'text-failed bg-failed/10'
              : 'text-ink-muted'
          return <div key={i} className={cls}>{line || ' '}</div>
        })}
      </pre>
    </div>
  )
}

function InfoPane() {
  const session = usePiStore((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId) ?? null,
  )
  const usage = usePiStore((s) =>
    s.activeSessionId ? s.usageById[s.activeSessionId] ?? null : null,
  )
  const items = usePiStore((s) =>
    s.activeSessionId ? s.timelineById[s.activeSessionId] ?? EMPTY_ITEMS : EMPTY_ITEMS,
  )
  const openFileInPanel = usePiStore((s) => s.openFileInPanel)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const files = useMemo(() => collectTouchedFiles(items), [items])
  const selectedFile = files.find((f) => f.path === selectedPath) ?? files[0] ?? null

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-[11.5px] text-ink-faint select-none">暂无会话</span>
      </div>
    )
  }

  const st = STATUS_LABEL[session.status] ?? STATUS_LABEL.idle
  const u: PiUsage | null = usage

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
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
              <button
                key={f.path}
                onClick={() => setSelectedPath(f.path)}
                onDoubleClick={() => void openFileInPanel(f.path)}
                className={[
                  'w-full flex items-center gap-2 px-1.5 py-1 rounded-btn text-[11.5px] text-left',
                  selectedFile?.path === f.path ? 'bg-primary-tint' : 'hover:bg-surface-2',
                ].join(' ')}
                title={`${f.path}\n单击查看 diff，双击在「文件」tab 中预览`}
              >
                <span className={f.kind === 'write' ? 'text-mint' : 'text-gold'} aria-hidden="true">
                  {f.kind === 'write' ? '＋' : '✎'}
                </span>
                <span className="text-ink-muted truncate font-mono flex-1">{baseName(f.path)}</span>
                <span className="text-[10px] text-done">+{f.plus}</span>
                <span className="text-[10px] text-failed">-{f.minus}</span>
              </button>
            ))}
            <DiffPreview file={selectedFile} />
          </div>
        )}
      </Section>
    </div>
  )
}

export default function RightPanel() {
  const tab = usePiStore((s) => s.rightTab)
  const setTab = usePiStore((s) => s.setRightTab)

  const tabCls = (active: boolean) =>
    [
      'px-3 h-full flex items-center text-[11.5px] border-b-2 transition-colors',
      active
        ? 'border-primary text-ink'
        : 'border-transparent text-ink-dim hover:text-ink',
    ].join(' ')

  return (
    <div className="w-[340px] flex-shrink-0 h-full bg-surface border-l border-line flex flex-col min-h-0">
      {/* tab 头 */}
      <div className="flex-shrink-0 flex items-stretch h-9 border-b border-line select-none">
        <button className={tabCls(tab === 'files')} onClick={() => setTab('files')}>
          文件
        </button>
        <button className={tabCls(tab === 'info')} onClick={() => setTab('info')}>
          会话信息
        </button>
      </div>

      {tab === 'files' ? (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center text-[11.5px] text-ink-dim">
              加载文件面板…
            </div>
          }
        >
          <FilesPanel />
        </Suspense>
      ) : (
        <InfoPane />
      )}
    </div>
  )
}
