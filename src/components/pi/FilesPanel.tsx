// 右栏「文件」tab（①）：上半文件树 + 下半文件内容预览。
// 树复用 workspaceStore（ws_list_dir 懒加载 / ws_search 搜索），从历史
// workbench/FileTree.tsx 恢复适配：右键菜单保留 复制绝对路径 / 复制相对路径 /
// 刷新目录（预览面板不做增删改）。点击文件 → piStore.previewFile。
import { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, type WsEntry } from '../../stores/workspaceStore'
import { usePiStore } from '../../stores/piStore'
import FileViewer from './FileViewer'

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

/** 右键菜单：复制绝对/相对路径 + 刷新目录。点击外部 / Esc / 失焦关闭。 */
function ContextMenu({
  menu,
  onClose,
  onCopied,
}: {
  menu: MenuState
  onClose: () => void
  onCopied: (label: string) => void
}) {
  const root = useWorkspaceStore((s) => s.root)
  const remote = useWorkspaceStore((s) => s.remote)
  const listDir = useWorkspaceStore((s) => s.listDir)
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
  const doCopy = async (text: string, label: string) => {
    onClose()
    if (await copyText(text)) onCopied(label)
  }

  const itemCls =
    'w-full text-left px-3 py-1.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors'

  const left = Math.max(4, Math.min(menu.x, window.innerWidth - 200))
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - 160))

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
      {entry.is_dir && (
        <>
          <div className="my-1 border-t border-line" />
          <button
            className={itemCls}
            onClick={() => {
              onClose()
              void listDir(entry.rel_path)
            }}
          >
            刷新目录
          </button>
        </>
      )}
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
  const children = useWorkspaceStore((s) => s.children[entry.rel_path])
  const toggleDir = useWorkspaceStore((s) => s.toggleDir)
  const selected = usePiStore((s) => s.preview?.relPath === entry.rel_path)
  const previewFile = usePiStore((s) => s.previewFile)

  const heavy = entry.is_dir && HEAVY.has(entry.name)

  return (
    <>
      <button
        onClick={() =>
          entry.is_dir
            ? void toggleDir(entry.rel_path)
            : previewFile(entry.rel_path, entry.name)
        }
        onContextMenu={(e) => onMenu(e, entry)}
        title={entry.rel_path}
        className={[
          'w-full flex items-center gap-1 py-[3px] pr-2 text-left transition-colors group rounded-md',
          selected ? 'bg-lavender/15 text-ink' : 'hover:bg-surface-2 text-ink-muted',
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
            'text-[12px] truncate flex-1 group-hover:text-ink',
            heavy ? 'text-ink-dim/70' : '',
          ].join(' ')}
        >
          {entry.name}
        </span>
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

export default function FilesPanel() {
  const name = useWorkspaceStore((s) => s.name)
  const rootChildren = useWorkspaceStore((s) => s.children[''])
  const searchQuery = useWorkspaceStore((s) => s.searchQuery)
  const searchResults = useWorkspaceStore((s) => s.searchResults)
  const searching = useWorkspaceStore((s) => s.searching)
  const runSearch = useWorkspaceStore((s) => s.runSearch)
  const clearSearch = useWorkspaceStore((s) => s.clearSearch)
  const listDir = useWorkspaceStore((s) => s.listDir)
  const remote = useWorkspaceStore((s) => s.remote)
  const preview = usePiStore((s) => s.preview)
  const previewFile = usePiStore((s) => s.previewFile)

  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const onMenu = (e: React.MouseEvent, entry: WsEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    void runSearch(q)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── 上半：文件树 ── */}
      <div className={['flex flex-col min-h-0', preview ? 'h-[45%]' : 'flex-1'].join(' ')}>
        <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-line flex-shrink-0">
          <span
            className="text-[11px] text-ink-muted font-medium truncate flex-1"
            title={name ?? ''}
          >
            {name ?? '资源管理器'}
          </span>
          {copied && <span className="text-[10px] text-mint select-none">已复制{copied}</span>}
          <button
            onClick={() => void listDir('')}
            title="刷新根目录"
            className="text-[11px] text-ink-dim hover:text-sky px-1"
          >
            ⟳
          </button>
        </div>

        <form onSubmit={submitSearch} className="px-2 py-1.5 border-b border-line flex-shrink-0">
          <div className="flex items-center gap-1 rounded-input bg-surface-2 border border-line px-2 py-0.5">
            <span className="text-[10px] text-ink-dim">🔍</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={remote ? '远程暂不支持搜索' : '搜索文件 / 内容'}
              disabled={!!remote}
              className="flex-1 bg-transparent text-[11.5px] text-ink placeholder:text-ink-dim focus:outline-none min-w-0 disabled:opacity-60"
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

        <div className="flex-1 min-h-0 overflow-y-auto py-1 px-0.5">
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
                    previewFile(
                      h.rel_path,
                      h.rel_path.split('/').pop() ?? h.rel_path,
                      h.line ?? undefined,
                    )
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
      </div>

      {/* ── 下半：文件预览 ── */}
      {preview && <FileViewer preview={preview} />}

      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} onCopied={setCopied} />
      )}
    </div>
  )
}
