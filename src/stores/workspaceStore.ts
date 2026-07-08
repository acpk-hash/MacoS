// 工作区文件系统 / 编辑器状态（G2b）。
//
// 与 workbenchStore（pi 引擎接线）解耦：这里只管「打开文件夹 → 文件树 +
// 多标签 Monaco 编辑器」。pi 的 AI 会话仍由 workbenchStore 驱动；页面把两者
// 组合起来（选目录时同时调 ws_open_folder 和 workbench_open）。
//
// G2c：新增「远程数据源」——当 remote 非空时，文件树/编辑器的所有文件操作
// 改走 ssh_*（SFTP）命令；本地与远程复用同一套树/编辑器 UI。
import { create } from 'zustand'
import { languageForExt } from '../lib/monacoSetup'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

/** Active remote (SSH) data source; `null` means the local filesystem. */
export interface RemoteRef {
  connId: string
  host: string
  user: string
  root: string
}

/**
 * Route a filesystem op to the local `ws_*` command or, when a remote is
 * active, the matching `ssh_*` command (same arg shape + a `connId`). This lets
 * the file tree / editor reuse one code path for local and remote sources.
 */
async function fsInvoke<T>(
  remote: RemoteRef | null,
  op: 'list_dir' | 'read_file' | 'write_file' | 'create' | 'rename' | 'delete',
  args: Record<string, unknown>,
): Promise<T> {
  if (remote) return tauriInvoke<T>(`ssh_${op}`, { connId: remote.connId, ...args })
  return tauriInvoke<T>(`ws_${op}`, args)
}

export interface WsEntry {
  name: string
  rel_path: string
  is_dir: boolean
  size: number
  ext: string
}

interface WsFileContent {
  content: string
  encoding: string
  too_large: boolean
}

export interface WsSearchHit {
  rel_path: string
  line: number | null
  preview: string | null
}

/** One open editor tab. */
export interface OpenTab {
  relPath: string
  name: string
  language: string
  content: string
  savedContent: string
  encoding: string
  tooLarge: boolean
  /** AI 改动了此文件、但用户本地有未保存改动，需手动刷新。 */
  aiModified: boolean
}

function baseName(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** Best-effort: map an AI-reported (abs or rel) path to a workspace rel_path. */
function toRel(root: string | null, p: string): string {
  const s = p.replace(/\\/g, '/')
  if (!root) return s.replace(/^\.\//, '')
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const sl = s.toLowerCase()
  const rl = r.toLowerCase()
  if (sl === rl) return ''
  if (sl.startsWith(rl + '/')) return s.slice(r.length + 1)
  if (!/^([a-zA-Z]:\/|\/)/.test(s)) return s.replace(/^\.\//, '')
  return baseName(s)
}

interface WorkspaceStore {
  root: string | null
  name: string | null
  recent: string[]
  opening: boolean

  /** Active remote source (null = local). Local `root`/`name` are stashed so we
   *  can switch back without re-picking the folder. */
  remote: RemoteRef | null
  localRoot: string | null
  localName: string | null

  /** rel_path -> child entries (loaded dirs only; "" is the root). */
  children: Record<string, WsEntry[]>
  expanded: Set<string>
  loadingDirs: Set<string>

  tabs: OpenTab[]
  activeTab: string | null

  /** rel_paths the AI has touched this session (dot marker in the tree). */
  aiTouched: Set<string>

  searchQuery: string
  searchResults: WsSearchHit[]
  searching: boolean

  error: string | null
  notice: string | null

  openFolder: (path: string) => Promise<void>
  openRemote: (conn: RemoteRef) => Promise<void>
  switchToLocal: () => Promise<void>
  loadRecent: () => Promise<void>
  listDir: (rel: string) => Promise<void>
  toggleDir: (rel: string) => Promise<void>
  openFile: (rel: string, name: string) => Promise<void>
  setActive: (rel: string) => void
  closeTab: (rel: string) => void
  updateContent: (rel: string, content: string) => void
  saveTab: (rel: string) => Promise<void>
  reloadTab: (rel: string) => Promise<void>
  createNode: (parent: string, name: string, isDir: boolean) => Promise<void>
  deleteNode: (rel: string, isDir: boolean) => Promise<void>
  renameNode: (rel: string, nextName: string) => Promise<void>
  runSearch: (query: string) => Promise<void>
  clearSearch: () => void
  applyAiTouched: (paths: string[]) => Promise<void>
  reset: () => void
  clearNotice: () => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  root: null,
  name: null,
  recent: [],
  opening: false,

  remote: null,
  localRoot: null,
  localName: null,

  children: {},
  expanded: new Set<string>(),
  loadingDirs: new Set<string>(),

  tabs: [],
  activeTab: null,

  aiTouched: new Set<string>(),

  searchQuery: '',
  searchResults: [],
  searching: false,

  error: null,
  notice: null,

  openFolder: async (path) => {
    if (!isTauri) return
    set({ opening: true, error: null })
    try {
      const res = await tauriInvoke<{ root: string; name: string }>('ws_open_folder', { path })
      set({
        root: res.root,
        name: res.name,
        remote: null,
        localRoot: res.root,
        localName: res.name,
        opening: false,
        children: {},
        expanded: new Set<string>(),
        tabs: [],
        activeTab: null,
        aiTouched: new Set<string>(),
        searchQuery: '',
        searchResults: [],
      })
      await get().listDir('')
      set((s) => ({ expanded: new Set(s.expanded).add('') }))
      void get().loadRecent()
    } catch (e) {
      set({ opening: false, error: `打开文件夹失败：${String(e)}` })
    }
  },

  openRemote: async (conn) => {
    if (!isTauri) return
    set({ opening: true, error: null })
    try {
      set({
        remote: conn,
        root: conn.root,
        name: `${conn.user}@${conn.host}`,
        opening: false,
        children: {},
        expanded: new Set<string>(),
        tabs: [],
        activeTab: null,
        aiTouched: new Set<string>(),
        searchQuery: '',
        searchResults: [],
      })
      await get().listDir('')
      set((s) => ({ expanded: new Set(s.expanded).add('') }))
    } catch (e) {
      set({ opening: false, error: `打开远程主机失败：${String(e)}` })
    }
  },

  switchToLocal: async () => {
    const { localRoot, localName } = get()
    if (!localRoot) {
      set({ remote: null, notice: '尚未打开本地文件夹' })
      return
    }
    set({
      remote: null,
      root: localRoot,
      name: localName,
      children: {},
      expanded: new Set<string>(),
      tabs: [],
      activeTab: null,
      searchQuery: '',
      searchResults: [],
    })
    await get().listDir('')
    set((s) => ({ expanded: new Set(s.expanded).add('') }))
  },

  loadRecent: async () => {
    if (!isTauri) return
    try {
      const recent = await tauriInvoke<string[]>('ws_recent_folders')
      set({ recent })
    } catch {
      /* best effort */
    }
  },

  listDir: async (rel) => {
    if (!isTauri) return
    set((s) => ({ loadingDirs: new Set(s.loadingDirs).add(rel) }))
    try {
      const entries = await fsInvoke<WsEntry[]>(get().remote, 'list_dir', { relPath: rel })
      set((s) => {
        const loading = new Set(s.loadingDirs)
        loading.delete(rel)
        return { children: { ...s.children, [rel]: entries }, loadingDirs: loading }
      })
    } catch (e) {
      set((s) => {
        const loading = new Set(s.loadingDirs)
        loading.delete(rel)
        return { loadingDirs: loading, error: `读取目录失败：${String(e)}` }
      })
    }
  },

  toggleDir: async (rel) => {
    const { expanded, children } = get()
    const next = new Set(expanded)
    if (next.has(rel)) {
      next.delete(rel)
      set({ expanded: next })
      return
    }
    next.add(rel)
    set({ expanded: next })
    if (!children[rel]) await get().listDir(rel)
  },

  openFile: async (rel, name) => {
    if (!isTauri) return
    const existing = get().tabs.find((t) => t.relPath === rel)
    if (existing) {
      set({ activeTab: rel })
      return
    }
    try {
      const res = await fsInvoke<WsFileContent>(get().remote, 'read_file', { relPath: rel })
      const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
      const tab: OpenTab = {
        relPath: rel,
        name,
        language: languageForExt(ext),
        content: res.content,
        savedContent: res.content,
        encoding: res.encoding,
        tooLarge: res.too_large,
        aiModified: false,
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTab: rel }))
    } catch (e) {
      set({ error: `打开文件失败：${String(e)}` })
    }
  },

  setActive: (rel) => set({ activeTab: rel }),

  closeTab: (rel) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.relPath === rel)
      const tabs = s.tabs.filter((t) => t.relPath !== rel)
      let activeTab = s.activeTab
      if (activeTab === rel) {
        const fallback = tabs[idx] ?? tabs[idx - 1] ?? tabs[0]
        activeTab = fallback ? fallback.relPath : null
      }
      return { tabs, activeTab }
    })
  },

  updateContent: (rel, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.relPath === rel ? { ...t, content } : t)),
    }))
  },

  saveTab: async (rel) => {
    if (!isTauri) return
    const tab = get().tabs.find((t) => t.relPath === rel)
    if (!tab || tab.tooLarge) return
    if (tab.content === tab.savedContent && !tab.aiModified) return
    try {
      await fsInvoke<void>(get().remote, 'write_file', { relPath: rel, content: tab.content })
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.relPath === rel ? { ...t, savedContent: t.content, aiModified: false } : t,
        ),
        notice: `已保存 ${tab.name}`,
      }))
    } catch (e) {
      set({ error: `保存失败：${String(e)}` })
    }
  },

  reloadTab: async (rel) => {
    if (!isTauri) return
    try {
      const res = await fsInvoke<WsFileContent>(get().remote, 'read_file', { relPath: rel })
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.relPath === rel
            ? {
                ...t,
                content: res.content,
                savedContent: res.content,
                encoding: res.encoding,
                tooLarge: res.too_large,
                aiModified: false,
              }
            : t,
        ),
      }))
    } catch (e) {
      set({ error: `刷新失败：${String(e)}` })
    }
  },

  createNode: async (parent, name, isDir) => {
    if (!isTauri || !name.trim()) return
    const rel = parent ? `${parent}/${name.trim()}` : name.trim()
    try {
      await fsInvoke<void>(get().remote, 'create', { relPath: rel, isDir })
      await get().listDir(parent)
      set((s) => ({
        expanded: new Set(s.expanded).add(parent),
        notice: isDir ? '已新建文件夹' : '已新建文件',
      }))
      if (!isDir) await get().openFile(rel, name.trim())
    } catch (e) {
      set({ error: `新建失败：${String(e)}` })
    }
  },

  deleteNode: async (rel, isDir) => {
    if (!isTauri) return
    try {
      await fsInvoke<void>(get().remote, 'delete', { relPath: rel })
      await get().listDir(parentRel(rel))
      get().closeTab(rel)
      set({ notice: isDir ? '已删除文件夹' : '已删除文件' })
    } catch (e) {
      set({ error: `删除失败：${String(e)}` })
    }
  },

  renameNode: async (rel, nextName) => {
    if (!isTauri || !nextName.trim()) return
    const parent = parentRel(rel)
    const to = parent ? `${parent}/${nextName.trim()}` : nextName.trim()
    if (to === rel) return
    try {
      await fsInvoke<void>(get().remote, 'rename', { from: rel, to })
      await get().listDir(parent)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.relPath === rel ? { ...t, relPath: to, name: nextName.trim() } : t,
        ),
        activeTab: s.activeTab === rel ? to : s.activeTab,
      }))
      set({ notice: '已重命名' })
    } catch (e) {
      set({ error: `重命名失败：${String(e)}` })
    }
  },

  runSearch: async (query) => {
    set({ searchQuery: query })
    const q = query.trim()
    if (!isTauri || !q) {
      set({ searchResults: [], searching: false })
      return
    }
    // Remote search over SFTP would be slow/heavy; not supported this milestone.
    if (get().remote) {
      set({ searchResults: [], searching: false, notice: '远程模式暂不支持全库搜索' })
      return
    }
    set({ searching: true })
    try {
      const hits = await tauriInvoke<WsSearchHit[]>('ws_search', { query: q, max: 100 })
      set({ searchResults: hits, searching: false })
    } catch (e) {
      set({ searching: false, error: `搜索失败：${String(e)}` })
    }
  },

  clearSearch: () => set({ searchQuery: '', searchResults: [] }),

  applyAiTouched: async (paths) => {
    const { root, tabs, children, expanded, remote } = get()
    // AI edits only ever land on the local workspace; skip while browsing remote.
    if (remote) return
    if (paths.length === 0) return
    const rels = paths.map((p) => toRel(root, p)).filter((r) => r.length > 0)
    if (rels.length === 0) return

    const touched = new Set(get().aiTouched)
    rels.forEach((r) => touched.add(r))

    const openMatch = new Set(rels)
    const nextTabs = tabs.map((t) => {
      if (!openMatch.has(t.relPath)) return t
      const dirty = t.content !== t.savedContent
      if (dirty) return { ...t, aiModified: true }
      return t
    })
    set({ aiTouched: touched, tabs: nextTabs })

    for (const t of tabs) {
      if (openMatch.has(t.relPath) && t.content === t.savedContent) {
        await get().reloadTab(t.relPath)
      }
    }

    const dirsToRefresh = new Set<string>()
    for (const r of rels) {
      const par = parentRel(r)
      if (children[par] !== undefined || expanded.has(par) || par === '') {
        dirsToRefresh.add(par)
      }
    }
    for (const d of dirsToRefresh) await get().listDir(d)
  },

  reset: () =>
    set({
      root: null,
      name: null,
      remote: null,
      localRoot: null,
      localName: null,
      children: {},
      expanded: new Set<string>(),
      loadingDirs: new Set<string>(),
      tabs: [],
      activeTab: null,
      aiTouched: new Set<string>(),
      searchQuery: '',
      searchResults: [],
    }),

  clearNotice: () => set({ notice: null, error: null }),
}))
