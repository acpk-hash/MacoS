// mcpStore -- MCP 管理页面状态（已安装 + 推荐目录 + 安装/删除流）。
// 后端契约（mcp.rs + lib.rs）：
//   mcp_list()                     -> McpServer[]
//   mcp_add({name,command,args,env}) -> void
//   mcp_remove({name})             -> void
//   mcp_catalog()                  -> McpCatalogEntry[]
import { create } from 'zustand'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface McpServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  category: string
  npm_package: string
  default_command: string
  default_args: string[]
  env_hints: [string, string][]
}

interface McpStore {
  // 已安装
  installed: McpServer[]
  installedLoading: boolean
  installedError: string | null

  // 目录
  catalog: McpCatalogEntry[]
  catalogLoading: boolean

  // 操作状态
  installing: string | null
  removing: string | null
  notice: string | null

  // 搜索/过滤
  query: string
  category: string

  // 安装对话框
  installDialogEntry: McpCatalogEntry | null
  installDialogEnv: Record<string, string>
  installDialogArgs: string[]

  // 动作
  loadInstalled: () => Promise<void>
  loadCatalog: () => Promise<void>
  remove: (name: string) => Promise<void>
  setQuery: (q: string) => void
  setCategory: (c: string) => void
  clearNotice: () => void
  openInstallDialog: (entry: McpCatalogEntry) => void
  closeInstallDialog: () => void
  setInstallEnvVar: (key: string, value: string) => void
  setInstallArgs: (args: string[]) => void
  confirmInstall: () => Promise<void>
}

export const useMcpStore = create<McpStore>((set, get) => ({
  installed: [],
  installedLoading: false,
  installedError: null,

  catalog: [],
  catalogLoading: false,

  installing: null,
  removing: null,
  notice: null,

  query: '',
  category: '',

  installDialogEntry: null,
  installDialogEnv: {},
  installDialogArgs: [],

  loadInstalled: async () => {
    if (!isTauri) return
    set({ installedLoading: true, installedError: null })
    try {
      const list = await tauriInvoke<McpServer[]>('mcp_list')
      set({ installed: list, installedLoading: false })
    } catch (e) {
      set({ installedError: String(e), installedLoading: false })
    }
  },

  loadCatalog: async () => {
    if (!isTauri) return
    set({ catalogLoading: true })
    try {
      const list = await tauriInvoke<McpCatalogEntry[]>('mcp_catalog')
      set({ catalog: list, catalogLoading: false })
    } catch {
      set({ catalogLoading: false })
    }
  },

  remove: async (name: string) => {
    if (!isTauri) return
    set({ removing: name })
    try {
      await tauriInvoke('mcp_remove', { name })
      set({ notice: `已删除 ${name}`, removing: null })
      await get().loadInstalled()
    } catch (e) {
      set({ notice: `删除失败: ${e}`, removing: null })
    }
  },

  setQuery: (q) => set({ query: q }),
  setCategory: (c) => set({ category: c }),
  clearNotice: () => set({ notice: null }),

  openInstallDialog: (entry) => {
    const env: Record<string, string> = {}
    for (const [k] of entry.env_hints) {
      env[k] = ''
    }
    set({
      installDialogEntry: entry,
      installDialogEnv: env,
      installDialogArgs: [...entry.default_args],
    })
  },

  closeInstallDialog: () =>
    set({ installDialogEntry: null, installDialogEnv: {}, installDialogArgs: [] }),

  setInstallEnvVar: (key, value) => {
    const env = { ...get().installDialogEnv, [key]: value }
    set({ installDialogEnv: env })
  },

  setInstallArgs: (args) => set({ installDialogArgs: args }),

  confirmInstall: async () => {
    const { installDialogEntry, installDialogEnv, installDialogArgs } = get()
    if (!installDialogEntry || !isTauri) return
    const name = installDialogEntry.id
    set({ installing: name })
    try {
      // 过滤空值 env
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(installDialogEnv)) {
        if (v.trim()) env[k] = v.trim()
      }
      await tauriInvoke('mcp_add', {
        name,
        command: installDialogEntry.default_command,
        args: installDialogArgs,
        env,
      })
      set({
        notice: `已安装 ${installDialogEntry.name}`,
        installing: null,
        installDialogEntry: null,
        installDialogEnv: {},
        installDialogArgs: [],
      })
      await get().loadInstalled()
    } catch (e) {
      set({ notice: `安装失败: ${e}`, installing: null })
    }
  },
}))
