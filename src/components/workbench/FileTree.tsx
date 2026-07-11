// 左栏文件树（G2b/G2c）。ws_list_dir / ssh_list_dir 懒加载 + 顶部搜索。
// P3：右键菜单升级为自绘深色菜单——复制绝对/相对路径 + 新建/重命名/删除
// （原 window.prompt 指令式交互仅保留在名称输入环节）。
// AI 改动过的文件（workspaceStore.aiTouched）显示小圆点标记。
// 顶部可切换「本地 / 已连远程主机」数据源（G2c）。
import { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, type WsEntry } from '../../stores/workspaceStore'
import { useSshStore } from '../../stores/sshStore'
import StatusDot from '../ui/StatusDot'

const HEAVY = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next', '.venv'])

function extTone(ext: string): string {
  const e = ext.toLowerCase()
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(e)) return 'text-sky'
  if (['json', 'yml', 'yaml', 'toml', 'ini', 'lock'].includes(e)) return 'text-gold'
  if (['css', 'scss', 'less'].includes(e)) return 'text-sakura'
  if (['md', 'markdown', 'txt'].includes(e)) return 'text-ink-muted'
  if (['rs', 'go', 'py', 'java', 'c', 'cpp', 'cs', 'rb', 'php'].includes(e)) return 'text-mint'
  if (['html', 'htm', 'xml', 'vue', 'svg'].includes(e)) return 'text-coral'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(e)) return 'text-lavender'
  return 'text-ink-dim'
}

function fileGlyph(ext: string): string {
  const e = ext.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(e)) return '🖼'
  if (['md', 'markdown'].includes(e)) return '📝'
  if (['json', 'yml', 'yaml', 'toml', 'ini'].includes(e)) return '⚙'
  return '›'
}

/** 复制到剪贴板：优先 navigator.clipboard，失败回退 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** 工作根 + rel_path 拼绝对路径：本地按根的分隔符风格，远程恒用 '/'。 */
function absPath(root: string, rel: string, isRemote: boolean): string {
  if (!rel) return root
  if (isRemote) return root.replace(/\/+$/, '') + '/' + rel
  const winStyle = root.includes('\\') || /^[a-zA-Z]:/.test(root)
  if (winStyle) return root.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\')
  return root.replace(/\/+$/, '') + '/' + rel
}

interface MenuState {
  x: number
  y: number
  entry: WsEntry
}

/** 右键上下文菜单（深色）：点击外部 / Esc / 窗口失焦即关闭。 */
function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const root = useWorkspaceStore((s) => s.root)
  const remote = useWorkspaceStore((s) => s.remote)
  const createNode = useWorkspaceStore((s) => s.createNode)
  const renameNode = useWorkspaceStore((s) => s.renameNode)
  const deleteNode = useWorkspaceStore((s) => s.deleteNode)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const entry = menu.entry
  // 文件 → 在其所在目录新建；文件夹 → 在其内部新建。
  const parent = entry.is_dir
    ? entry.rel_path
    : entry.rel_path.split('/').slice(0, -1).join('/')

  const doCopy = async (text: string, label: string) => {
    onClose()
    if (await copyText(text)) useWorkspaceStore.setState({ notice: `已复制${label}` })
    else useWorkspaceStore.setState({ error: '复制失败：无法访问剪贴板' })
  }

  const itemCls =
    'w-full text-left px-3 py-1.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors'

  // 视口边缘防溢出（菜单约 190×230）。
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - 200))
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - 240))

  return (
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[176px] py-1 rounded-md border border-line bg-elevated shadow-lg shadow-black/40"
      style={{ left, top }}
    >
      <div className="px-3 py-1 text-[10.5px] text-ink-dim truncate max-w-[240px] select-none">
        {entry.name}
      </div>
      <div className="my-1 border-t border-line" />
      <button
        className={itemCls}
        onClick={() => void doCopy(absPath(root ?? '', entry.rel_path, !!remote), '绝对路径')}
      >
        复制绝对路径
      </button>
      <button className={itemCls} onClick={() => void doCopy(entry.rel_path || '.', '相对路径')}>
        复制相对路径
      </button>
      <div className="my-1 border-t border-line" />
      <button
        className={itemCls}
        onClick={() => {
          onClose()
          const name = window.prompt('新文件名称', '')
          if (name) void createNode(parent, name, false)
        }}
      >
        新建文件
      </button>
      <button
        className={itemCls}
        onClick={() => {
          onClose()
          const name = window.prompt('新文件夹名称', '')
          if (name) void createNode(parent, name, true)
        }}
      >
        新建文件夹
      </button>
      <button
        className={itemCls}
        onClick={() => {
          onClose()
          const name = window.prompt('重命名为', entry.name)
          if (name) void renameNode(entry.rel_path, name)
        }}
      >
        重命名
      </button>
      <div className="my-1 border-t border-line" />
      <button
        className="w-full text-left px-3 py-1.5 text-[12px] text-coral hover:bg-coral/10 transition-colors"
        onClick={() => {
          onClose()
          if (window.confirm(`确认删除「${entry.name}」？`)) {
            void deleteNode(entry.rel_path, entry.is_dir)
          }
        }}
      >
        删除
      </button>
    </div>
  )
}

function Row({
  entry,
  depth,
  onMenu,
}: {
  entry: WsEntry
  depth: number
  onMenu: (e: React.MouseEvent, entry: WsEntry) => void
}) {
  const expanded = useWorkspaceStore((s) => s.expanded.has(entry.rel_path))
  const loading = useWorkspaceStore((s) => s.loadingDirs.has(entry.rel_path))
  const active = useWorkspaceStore((s) => s.activeTab === entry.rel_path)
  const touched = useWorkspaceStore((s) => s.aiTouched.has(entry.rel_path))
  const children = useWorkspaceStore((s) => s.children[entry.rel_path])
  const toggleDir = useWorkspaceStore((s) => s.toggleDir)
  const openFile = useWorkspaceStore((s) => s.openFile)

  const heavy = entry.is_dir && HEAVY.has(entry.name)

  return (
    <>
      <button
        onClick={() =>
          entry.is_dir
            ? void toggleDir(entry.rel_path)
            : void openFile(entry.rel_path, entry.name)
        }
        onContextMenu={(e) => onMenu(e, entry)}
        title={entry.rel_path}
        className={[
          'w-full flex items-center gap-1 py-[3px] pr-2 text-left transition-colors group rounded-md',
          active ? 'bg-lavender/15 text-ink' : 'hover:bg-surface-2 text-ink-muted',
        ].join(' ')}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        {entry.is_dir ? (
          <span className="w-3 text-[10px] text-ink-dim flex-shrink-0 select-none">
            {loading ? '⋯' : expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <span
          className={[
            'text-[11px] flex-shrink-0 w-3.5 text-center',
            entry.is_dir ? (heavy ? 'text-ink-dim' : 'text-gold') : extTone(entry.ext),
          ].join(' ')}
        >
          {entry.is_dir ? (expanded ? '📂' : '📁') : fileGlyph(entry.ext)}
        </span>
        <span
          className={[
            'text-[12.5px] truncate flex-1 group-hover:text-ink',
            heavy ? 'text-ink-dim/70' : '',
          ].join(' ')}
        >
          {entry.name}
        </span>
        {touched && !entry.is_dir && (
          <StatusDot status="done" size={6} className="flex-shrink-0" />
        )}
      </button>
      {entry.is_dir && expanded && children && (
        <div>
          {children.length === 0 ? (
            <div
              className="text-[11px] text-ink-dim py-1 select-none"
              style={{ paddingLeft: 22 + depth * 12 }}
            >
              空目录
            </div>
          ) : (
            children.map((c) => (
              <Row key={c.rel_path} entry={c} depth={depth + 1} onMenu={onMenu} />
            ))
          )}
        </div>
      )}
    </>
  )
}

export default function FileTree() {
  const name = useWorkspaceStore((s) => s.name)
  const rootChildren = useWorkspaceStore((s) => s.children[''])
  const searchQuery = useWorkspaceStore((s) => s.searchQuery)
  const searchResults = useWorkspaceStore((s) => s.searchResults)
  const searching = useWorkspaceStore((s) => s.searching)
  const runSearch = useWorkspaceStore((s) => s.runSearch)
  const clearSearch = useWorkspaceStore((s) => s.clearSearch)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const createNode = useWorkspaceStore((s) => s.createNode)
  const listDir = useWorkspaceStore((s) => s.listDir)
  const remote = useWorkspaceStore((s) => s.remote)
  const openRemote = useWorkspaceStore((s) => s.openRemote)
  const switchToLocal = useWorkspaceStore((s) => s.switchToLocal)
  const conns = useSshStore((s) => s.conns)
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)

  const onMenu = (e: React.MouseEvent, entry: WsEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    void runSearch(q)
  }

  const onSourceChange = (value: string) => {
    if (value === 'local') {
      void switchToLocal()
      return
    }
    const c = conns.find((x) => x.conn_id === value)
    if (c) void openRemote({ connId: c.conn_id, host: c.host, user: c.user, root: c.root })
  }

  return (
    <div className="w-60 flex-shrink-0 flex flex-col h-full glass border-r border-line">
      {/* 数据源切换（有远程连接时才显示） */}
      {conns.length > 0 && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-line">
          <StatusDot status={remote ? 'running' : 'done'} size={7} />
          <select
            value={remote?.connId ?? 'local'}
            onChange={(e) => onSourceChange(e.target.value)}
            title="切换文件树数据源：本地 / 远程主机"
            className="flex-1 min-w-0 bg-surface-2 border border-line rounded-input px-1.5 py-0.5 text-[11px] text-ink-muted focus:outline-none focus:border-line-strong"
          >
            <option value="local">本地</option>
            {conns.map((c) => (
              <option key={c.conn_id} value={c.conn_id}>
                {c.user}@{c.host}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center gap-1 px-2.5 py-2 border-b border-line">
        <span className="text-[11px] text-ink-muted font-medium truncate flex-1" title={name ?? ''}>
          {name ?? '资源管理器'}
        </span>
        <button
          onClick={() => {
            const n = window.prompt('新文件名称', '')
            if (n) void createNode('', n, false)
          }}
          title="在根目录新建文件"
          className="text-[12px] text-ink-dim hover:text-sakura px-1"
        >
          ＋
        </button>
        <button
          onClick={() => {
            const n = window.prompt('新文件夹名称', '')
            if (n) void createNode('', n, true)
          }}
          title="在根目录新建文件夹"
          className="text-[12px] text-ink-dim hover:text-gold px-1"
        >
          📁
        </button>
        <button
          onClick={() => void listDir('')}
          title="刷新根目录"
          className="text-[11px] text-ink-dim hover:text-sky px-1"
        >
          ⟳
        </button>
      </div>

      <form onSubmit={submitSearch} className="px-2 py-2 border-b border-line">
        <div className="flex items-center gap-1 rounded-input bg-surface-2 border border-line px-2 py-1">
          <span className="text-[11px] text-ink-dim">🔍</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={remote ? '远程暂不支持搜索' : '搜索文件 / 内容'}
            disabled={!!remote}
            className="flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-dim focus:outline-none min-w-0 disabled:opacity-60"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setQ('')
                clearSearch()
              }}
              className="text-[11px] text-ink-dim hover:text-coral"
            >
              ✕
            </button>
          )}
        </div>
      </form>

      <div className="flex-1 overflow-y-auto py-1">
        {searchQuery ? (
          searching ? (
            <p className="text-[11px] text-ink-dim text-center mt-4">搜索中…</p>
          ) : searchResults.length === 0 ? (
            <p className="text-[11px] text-ink-dim text-center mt-4">无匹配结果</p>
          ) : (
            searchResults.map((h, i) => (
              <button
                key={`${h.rel_path}:${h.line ?? 'name'}:${i}`}
                onClick={() =>
                  void openFile(h.rel_path, h.rel_path.split('/').pop() ?? h.rel_path)
                }
                title={h.rel_path}
                className="w-full text-left px-2.5 py-1 hover:bg-surface-2 transition-colors"
              >
                <div className="text-[12px] text-ink-muted truncate">
                  {h.rel_path.split('/').pop()}
                  {h.line != null && <span className="text-ink-dim"> :{h.line}</span>}
                </div>
                {h.preview && (
                  <div className="text-[11px] text-ink-dim font-mono truncate">{h.preview}</div>
                )}
              </button>
            ))
          )
        ) : rootChildren ? (
          rootChildren.map((c) => <Row key={c.rel_path} entry={c} depth={0} onMenu={onMenu} />)
        ) : (
          <p className="text-[11px] text-ink-dim text-center mt-4">加载中…</p>
        )}
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
