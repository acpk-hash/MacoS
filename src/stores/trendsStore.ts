import { create } from 'zustand'

const isTauri = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export type TrendSourceKind = 'platform' | 'rss' | 'web'

export interface TrendSource {
  id: string
  name: string
  kind: TrendSourceKind
  url: string
  platformId?: string
  apiUrl?: string
  expectedDomain?: string
  keywords: string[]
  intervalMin: number
  enabled: boolean
  lastFetchedAt: number | null
  error: string | null
}

export interface TrendItem {
  id: string
  title: string
  url: string
  sourceUrl: string
  sourceName: string
  snippet: string
  fetchedAt: number
  read: boolean
  pinned: boolean
}

interface RawTrendItem {
  title: string
  url: string
  source_url: string
  snippet: string
}

interface RawTrendResult {
  source_url: string
  fetched_at: number
  items: RawTrendItem[]
}

interface TrendsState {
  sources: TrendSource[]
  items: TrendItem[]
  selectedSourceId: string | null
  running: boolean
  autoRefresh: boolean
  query: string
  addSource: (input: Omit<TrendSource, 'id' | 'lastFetchedAt' | 'error'>) => void
  updateSource: (id: string, patch: Partial<TrendSource>) => void
  removeSource: (id: string) => void
  fetchSource: (id: string) => Promise<void>
  fetchAll: () => Promise<void>
  markRead: (id: string, read?: boolean) => void
  togglePin: (id: string) => void
  clearRead: () => void
  setSelectedSourceId: (id: string | null) => void
  setAutoRefresh: (v: boolean) => void
  setQuery: (q: string) => void
  hydrate: () => void
  persist: () => void
}

const LS_KEY = 'iris.trends.v1'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const NEWSNOW_API = 'https://newsnow.busiyi.world/api/s'

const DEFAULT_SOURCES: TrendSource[] = [
  {
    id: 'src-newsnow-zhihu',
    name: '知乎',
    kind: 'platform',
    url: '',
    platformId: 'zhihu',
    apiUrl: NEWSNOW_API,
    expectedDomain: 'zhihu.com',
    keywords: [],
    intervalMin: 30,
    enabled: true,
    lastFetchedAt: null,
    error: null,
  },
  {
    id: 'src-newsnow-weibo',
    name: '微博',
    kind: 'platform',
    url: '',
    platformId: 'weibo',
    apiUrl: NEWSNOW_API,
    expectedDomain: 'weibo.com',
    keywords: [],
    intervalMin: 30,
    enabled: true,
    lastFetchedAt: null,
    error: null,
  },
  {
    id: 'src-hacker-news-rss',
    name: 'Hacker News',
    kind: 'rss',
    url: 'https://hnrss.org/frontpage',
    keywords: [],
    intervalMin: 60,
    enabled: true,
    lastFetchedAt: null,
    error: null,
  },
]

function normalizeUrl(url: string): string {
  return url.trim().replace(/\s+/g, '')
}

function itemKey(url: string, title: string): string {
  return (url || title).toLowerCase()
}

export const useTrendsStore = create<TrendsState>((set, get) => ({
  sources: DEFAULT_SOURCES,
  items: [],
  selectedSourceId: null,
  running: false,
  autoRefresh: false,
  query: '',

  hydrate: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return
      const data = JSON.parse(raw) as Partial<Pick<TrendsState, 'sources' | 'items' | 'autoRefresh'>>
      set({
        sources: Array.isArray(data.sources) && data.sources.length > 0
          ? data.sources.map((src) => ({ ...src, kind: src.kind ?? 'web' }))
          : DEFAULT_SOURCES,
        items: Array.isArray(data.items) ? data.items : [],
        autoRefresh: data.autoRefresh === true,
      })
    } catch { /* ignore */ }
  },

  persist: () => {
    try {
      const { sources, items, autoRefresh } = get()
      localStorage.setItem(LS_KEY, JSON.stringify({ sources, items: items.slice(0, 500), autoRefresh }))
    } catch { /* ignore */ }
  },

  addSource: (input) => {
    const source: TrendSource = { ...input, id: uid(), url: normalizeUrl(input.url), lastFetchedAt: null, error: null }
    set((s) => ({ sources: [source, ...s.sources], selectedSourceId: source.id }))
    get().persist()
  },

  updateSource: (id, patch) => {
    set((s) => ({ sources: s.sources.map((src) => src.id === id ? { ...src, ...patch, url: patch.url != null ? normalizeUrl(patch.url) : src.url } : src) }))
    get().persist()
  },

  removeSource: (id) => {
    set((s) => ({ sources: s.sources.filter((src) => src.id !== id), selectedSourceId: s.selectedSourceId === id ? null : s.selectedSourceId }))
    get().persist()
  },

  fetchSource: async (id) => {
    const src = get().sources.find((s) => s.id === id)
    if (!src || !src.enabled) return
    if (!isTauri) {
      set((s) => ({ sources: s.sources.map((x) => x.id === id ? { ...x, error: '热点抓取需要桌面端运行' } : x) }))
      return
    }
    set({ running: true })
    try {
      const res = await tauriInvoke<RawTrendResult>('trends_fetch', {
        req: {
          kind: src.kind,
          url: src.url,
          platform_id: src.platformId,
          api_url: src.apiUrl,
          expected_domain: src.expectedDomain,
          keywords: src.keywords,
        },
      })
      const fetchedAt = res.fetched_at || Date.now()
      set((s) => {
        const existing = new Map(s.items.map((it) => [itemKey(it.url, it.title), it]))
        const fresh = res.items.map((it) => {
          const key = itemKey(it.url, it.title)
          const old = existing.get(key)
          return {
            id: old?.id ?? uid(),
            title: it.title,
            url: it.url,
            sourceUrl: it.source_url,
            sourceName: src.name,
            snippet: it.snippet,
            fetchedAt,
            read: old?.read ?? false,
            pinned: old?.pinned ?? false,
          } satisfies TrendItem
        })
        for (const it of fresh) existing.set(itemKey(it.url, it.title), it)
        const items = Array.from(existing.values()).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.fetchedAt - a.fetchedAt).slice(0, 500)
        return {
          items,
          sources: s.sources.map((x) => x.id === id ? { ...x, lastFetchedAt: fetchedAt, error: null } : x),
        }
      })
    } catch (e) {
      set((s) => ({ sources: s.sources.map((x) => x.id === id ? { ...x, error: String(e) } : x) }))
    } finally {
      set({ running: false })
      get().persist()
    }
  },

  fetchAll: async () => {
    for (const src of get().sources.filter((s) => s.enabled)) await get().fetchSource(src.id)
  },

  markRead: (id, read = true) => {
    set((s) => ({ items: s.items.map((it) => it.id === id ? { ...it, read } : it) }))
    get().persist()
  },

  togglePin: (id) => {
    set((s) => ({ items: s.items.map((it) => it.id === id ? { ...it, pinned: !it.pinned } : it).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.fetchedAt - a.fetchedAt) }))
    get().persist()
  },

  clearRead: () => {
    set((s) => ({ items: s.items.filter((it) => !it.read || it.pinned) }))
    get().persist()
  },

  setSelectedSourceId: (id) => set({ selectedSourceId: id }),
  setAutoRefresh: (v) => { set({ autoRefresh: v }); get().persist() },
  setQuery: (q) => set({ query: q }),
}))
