// skillsStore — Skills 顶级大类（技能市场 + 已安装管理）的状态。
// 后端契约（skills_hub.rs）：
//   skills_market_list()            → MarketEntry[]（agents+skills 合并清单）
//   skills_market_install({id})     → 安装路径 string
//   skills_local_list()             → LocalSkill[]（共享目录扫描）
//   skills_read({name})             → SKILL.md 全文
//   skills_uninstall({name})        → void
// 安装位置：app_data_dir/skills/<name>/SKILL.md；pi_open 时镜像进会话目录，
// 编码窗口输入 / 可唤起（/skill:<name>）。
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

export interface MarketEntry {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  file: string
  /** 来源清单："agent" | "skill"（都是提示词型，装完都是 pi skill）。 */
  kind: string
}

export interface LocalSkill {
  name: string
  description: string
  dir: string
  source: string
}

export interface PublicSkill {
  id: string
  name: string
  description: string
  author: string
  source_url: string
  install_url: string | null
  stars: number
  topics: string[]
}

interface SkillsStore {
  // 市场
  market: MarketEntry[]
  marketLoading: boolean
  marketError: string | null
  /** 搜索关键词（名称/描述/分类/标签模糊匹配）。 */
  query: string
  /** 当前分类过滤（null = 全部）。 */
  category: string | null

  // 已安装
  installed: LocalSkill[]
  /** 安装中的条目 id 集合（按钮态）。 */
  installing: Record<string, boolean>
  /** 装完的提示（「编码窗口输入 / 可唤起」）。 */
  notice: string | null

  // SKILL.md 预览
  viewing: { name: string; content: string } | null
  viewLoading: boolean

  // 公开搜索
  publicQuery: string
  publicResults: PublicSkill[]
  publicSearching: boolean
  publicError: string | null
  publicInstalling: Record<string, boolean>

  loadMarket: () => Promise<void>
  loadInstalled: () => Promise<void>
  install: (id: string) => Promise<void>
  uninstall: (name: string) => Promise<void>
  view: (name: string) => Promise<void>
  closeView: () => void
  setQuery: (q: string) => void
  setCategory: (c: string | null) => void
  clearNotice: () => void

  setPublicQuery: (q: string) => void
  searchPublic: () => Promise<void>
  installPublic: (skill: PublicSkill) => Promise<void>
}

/** 市场 id → 安装后的 skill 目录名（与后端 normalize_skill_name 同规则）。 */
export function normalizedSkillName(id: string): string {
  const out = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return out || 'skill'
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  market: [],
  marketLoading: false,
  marketError: null,
  query: '',
  category: null,

  installed: [],
  installing: {},
  notice: null,

  viewing: null,
  viewLoading: false,

  publicQuery: '',
  publicResults: [],
  publicSearching: false,
  publicError: null,
  publicInstalling: {},

  loadMarket: async () => {
    if (!isTauri) {
      set({ marketError: '仅桌面端可用（Tauri 环境未检测到）' })
      return
    }
    set({ marketLoading: true, marketError: null })
    try {
      const market = await tauriInvoke<MarketEntry[]>('skills_market_list')
      set({ market, marketLoading: false })
    } catch (e) {
      set({ marketError: String(e), marketLoading: false })
    }
  },

  loadInstalled: async () => {
    if (!isTauri) return
    try {
      const installed = await tauriInvoke<LocalSkill[]>('skills_local_list')
      set({ installed })
    } catch (e) {
      console.warn('[skillsStore] skills_local_list failed:', e)
    }
  },

  install: async (id) => {
    if (!isTauri) return
    set((s) => ({ installing: { ...s.installing, [id]: true }, notice: null }))
    try {
      await tauriInvoke<string>('skills_market_install', { id })
      await get().loadInstalled()
      set({
        notice: `「${id}」已安装 — 编码窗口输入 / 即可唤起（/skill:${normalizedSkillName(id)}）`,
      })
    } catch (e) {
      set({ notice: `安装失败：${String(e)}` })
    } finally {
      set((s) => {
        const installing = { ...s.installing }
        delete installing[id]
        return { installing }
      })
    }
  },

  uninstall: async (name) => {
    if (!isTauri) return
    try {
      await tauriInvoke<void>('skills_uninstall', { name })
      set((s) => ({
        installed: s.installed.filter((x) => x.name !== name),
        viewing: s.viewing?.name === name ? null : s.viewing,
        notice: null,
      }))
    } catch (e) {
      set({ notice: `卸载失败：${String(e)}` })
    }
  },

  view: async (name) => {
    if (!isTauri) return
    set({ viewLoading: true, viewing: { name, content: '' } })
    try {
      const content = await tauriInvoke<string>('skills_read', { name })
      set({ viewing: { name, content }, viewLoading: false })
    } catch (e) {
      set({ viewing: { name, content: `读取失败：${String(e)}` }, viewLoading: false })
    }
  },

  closeView: () => set({ viewing: null }),
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  clearNotice: () => set({ notice: null }),

  setPublicQuery: (publicQuery) => set({ publicQuery }),

  searchPublic: async () => {
    if (!isTauri) {
      set({ publicError: '仅桌面端可用' })
      return
    }
    const q = get().publicQuery.trim()
    set({ publicSearching: true, publicError: null })
    try {
      const results = await tauriInvoke<PublicSkill[]>('skills_search_public', {
        query: q,
        source: null,
      })
      set({ publicResults: results, publicSearching: false })
    } catch (e) {
      set({ publicError: String(e), publicSearching: false })
    }
  },

  installPublic: async (skill) => {
    if (!isTauri || !skill.install_url) return
    set((s) => ({
      publicInstalling: { ...s.publicInstalling, [skill.id]: true },
      notice: null,
    }))
    try {
      await tauriInvoke<string>('skills_public_install', {
        skillId: skill.id,
        skillMdUrl: skill.install_url,
      })
      await get().loadInstalled()
      const name = normalizedSkillName(skill.name)
      set({
        notice: `「${skill.name}」已安装 — 编码窗口输入 / 即可唤起（/skill:${name}）`,
      })
    } catch (e) {
      set({ notice: `安装失败：${String(e)}` })
    } finally {
      set((s) => {
        const publicInstalling = { ...s.publicInstalling }
        delete publicInstalling[skill.id]
        return { publicInstalling }
      })
    }
  },
}))
