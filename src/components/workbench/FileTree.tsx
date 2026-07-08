// 左栏文件树（G2b）。ws_list_dir 懒加载 + 顶部搜索 + 右键增删改。
// AI 改动过的文件（workspaceStore.aiTouched）显示小圆点标记。
import { useState } from 'react'
import { useWorkspaceStore, type WsEntry } from '../../stores/workspaceStore'
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

function Row({ entry, depth }: { entry: WsEntry; depth: number }) {
  const expanded = useWorkspaceStore((s) => s.expanded.has(entry.rel_path))
  const loading = useWorkspaceStore((s) => s.loadingDirs.has(entry.rel_path))
  const active = useWorkspaceStore((s) => s.activeTab === entry.rel_path)
  const touched = useWorkspaceStore((s) => s.aiTouched.has(entry.rel_path))
  const children = useWorkspaceStore((s) => s.children[entry.rel_path])
  const toggleDir = useWorkspaceStore((s) => s.toggleDir)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const createNode = useWorkspaceStore((s) => s.createNode)
  const deleteNode = useWorkspaceStore((s) => s.deleteNode)
  const renameNode = useWorkspaceStore((s) => s.renameNode)

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const action = window.prompt(
      `对「${entry.name}」：nf=新建文件 / nd=新建文件夹 / rn=重命名 / del=删除`,
      entry.is_dir ? 'nf' : 'rn',
    )
    if (!action) return
    const a = action.trim().toLowerCase()
    if (a === 'nf' || a === 'nd') {
      const parent = entry.is_dir
        ? entry.rel_path
        : entry.rel_path.split('/').slice(0, -1).join('/')
      const name = window.prompt(a === 'nd' ? '新文件夹名称' : '新文件名称', '')
      if (name) void createNode(parent, name, a === 'nd')
    } else if (a === 'rn') {
      const name = window.prompt('重命名为', entry.name)
      if (name) void renameNode(entry.rel_path, name)
    } else if (a === 'del') {
      if (window.confirm(`确认删除「${entry.name}」？`)) void deleteNode(entry.rel_path, entry.is_dir)
    }
  }

  const heavy = entry.is_dir && HEAVY.has(entry.name)

  return (
    <>
      <button
        onClick={() =>
          entry.is_dir
            ? void toggleDir(entry.rel_path)
            : void openFile(entry.rel_path, entry.name)
        }
        onContextMenu={onContext}
        title={entry.rel_path}
        className={[
          'w-full flex items-center gap-1 py-[3px] pr-2 text-left transition-colors group rounded-md',
          active ? 'bg-lavender/15 text-ink' : 'hover:bg-white/6 text-ink-muted',
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
            children.map((c) => <Row key={c.rel_path} entry={c} depth={depth + 1} />)
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
  const [q, setQ] = useState('')

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    void runSearch(q)
  }

  return (
    <div className="w-60 flex-shrink-0 flex flex-col h-full glass border-r border-line">
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
        <div className="flex items-center gap-1 rounded-input bg-black/25 border border-line px-2 py-1">
          <span className="text-[11px] text-ink-dim">🔍</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索文件 / 内容"
            className="flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-dim focus:outline-none min-w-0"
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
                className="w-full text-left px-2.5 py-1 hover:bg-white/6 transition-colors"
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
          rootChildren.map((c) => <Row key={c.rel_path} entry={c} depth={0} />)
        ) : (
          <p className="text-[11px] text-ink-dim text-center mt-4">加载中…</p>
        )}
      </div>
    </div>
  )
}
