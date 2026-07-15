import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocSource = 'office' | 'science' | 'agent' | 'upload' | 'import'
export type DocFormat = 'md' | 'docx' | 'html' | 'pdf' | 'txt'

export interface KBDocument {
  id: string
  title: string
  source: DocSource
  format: DocFormat
  /** File path or blob URL. */
  path: string
  tags: string[]
  createdAt: number
  updatedAt: number
  /** Optional markdown preview content (cached). */
  preview?: string
  /** Outgoing document links, e.g. Obsidian [[Wiki Links]]. */
  links?: string[]
  /** Size in bytes, if known. */
  size?: number
}

export interface KBTag {
  name: string
  color: string
}

export interface GraphNode {
  id: string
  label: string
  x: number
  y: number
  vx: number
  vy: number
  tags: string[]
}

export interface GraphEdge {
  source: string
  target: string
  /** Shared tags that form this relation. */
  relation: string
}

export type KBTab = 'docs' | 'graph' | 'io'

export type DocSortBy = 'time' | 'title' | 'format'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface KnowledgeState {
  tab: KBTab
  setTab: (t: KBTab) => void

  documents: KBDocument[]
  tags: KBTag[]
  sortBy: DocSortBy
  filterTag: string | null
  filterFormat: DocFormat | null
  searchQuery: string

  setSortBy: (s: DocSortBy) => void
  setFilterTag: (t: string | null) => void
  setFilterFormat: (f: DocFormat | null) => void
  setSearchQuery: (q: string) => void

  addDocument: (doc: KBDocument) => void
  removeDocument: (id: string) => void
  updateDocument: (id: string, patch: Partial<KBDocument>) => void
  addTag: (tag: KBTag) => void
  removeTag: (name: string) => void

  /** Collect documents from other stores (office/science/agent history). */
  collectFromStores: () => void

  /** Import an Obsidian vault directory (array of {name, content} objects). */
  importObsidianVault: (files: { name: string; content: string }[]) => void

  /** Import Notion export zip contents. */
  importNotionZip: (files: { name: string; content: string }[]) => void

  /** Export all markdown documents as a downloadable zip. */
  exportMarkdownFolder: () => void

  /** Persist to localStorage. */
  _persist: () => void
  /** Load from localStorage. */
  _hydrate: () => void
}

const LS_KEY = 'iris.knowledge.v1'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)))
}

function parseMarkdownSignals(content: string): { tags: string[]; links: string[] } {
  const tags: string[] = []
  const links: string[] = []
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  if (frontmatter) {
    const body = frontmatter[1]
    const tagLine = /^tags:\s*(.+)$/im.exec(body)
    if (tagLine) {
      const raw = tagLine[1].replace(/[\[\]"]/g, '')
      tags.push(...raw.split(/[,#]/).map((x) => x.trim()).filter(Boolean))
    }
  }
  for (const m of content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.push(m[2])
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) links.push(m[1].trim())
  for (const m of content.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/gi)) links.push(m[1].split('/').pop()!.replace(/\.md$/i, ''))
  return { tags: uniq(tags), links: uniq(links) }
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  tab: 'docs',
  setTab: (t) => set({ tab: t }),

  documents: [],
  tags: [],
  sortBy: 'time',
  filterTag: null,
  filterFormat: null,
  searchQuery: '',

  setSortBy: (s) => set({ sortBy: s }),
  setFilterTag: (t) => set({ filterTag: t }),
  setFilterFormat: (f) => set({ filterFormat: f }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  addDocument: (doc) => {
    set((s) => ({ documents: [doc, ...s.documents] }))
    get()._persist()
  },

  removeDocument: (id) => {
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))
    get()._persist()
  },

  updateDocument: (id, patch) => {
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d,
      ),
    }))
    get()._persist()
  },

  addTag: (tag) => {
    set((s) => {
      if (s.tags.some((t) => t.name === tag.name)) return s
      return { tags: [...s.tags, tag] }
    })
    get()._persist()
  },

  removeTag: (name) => {
    set((s) => ({ tags: s.tags.filter((t) => t.name !== name) }))
    get()._persist()
  },

  collectFromStores: () => {
    // Collect from localStorage snapshots of other stores.
    const existing = new Set(get().documents.map((d) => d.path))
    const collected: KBDocument[] = []

    // Office history
    try {
      const raw = localStorage.getItem('iris.office.history.v1')
      if (raw) {
        const entries = JSON.parse(raw) as Array<{
          id?: string
          title?: string
          module?: string
          timestamp?: number
        }>
        for (const e of entries) {
          const path = `office://${e.id ?? uid()}`
          if (existing.has(path)) continue
          collected.push({
            id: uid(),
            title: e.title ?? '办公文档',
            source: 'office',
            format: 'md',
            path,
            tags: [e.module ?? 'office'],
            createdAt: e.timestamp ?? Date.now(),
            updatedAt: e.timestamp ?? Date.now(),
          })
          existing.add(path)
        }
      }
    } catch { /* ignore parse errors */ }

    // Science reports (stored by scienceStore)
    try {
      const raw = localStorage.getItem('iris.science.reports.v1')
      if (raw) {
        const reports = JSON.parse(raw) as Array<{
          paperId?: string
          title?: string
          markdown?: string
          createdAt?: number
        }>
        for (const r of reports) {
          const path = `science://${r.paperId ?? uid()}`
          if (existing.has(path)) continue
          collected.push({
            id: uid(),
            title: r.title ?? '科研报告',
            source: 'science',
            format: 'md',
            path,
            tags: ['science'],
            createdAt: r.createdAt ?? Date.now(),
            updatedAt: r.createdAt ?? Date.now(),
            preview: r.markdown,
          })
          existing.add(path)
        }
      }
    } catch { /* ignore */ }

    // Agent hub records
    try {
      const raw = localStorage.getItem('iris.agenthub.records.v1')
      if (raw) {
        const records = JSON.parse(raw) as Array<{
          id?: string
          name?: string
          createdAt?: number
        }>
        for (const r of records) {
          const path = `agent://${r.id ?? uid()}`
          if (existing.has(path)) continue
          collected.push({
            id: uid(),
            title: r.name ?? 'Agent 记录',
            source: 'agent',
            format: 'md',
            path,
            tags: ['agent'],
            createdAt: r.createdAt ?? Date.now(),
            updatedAt: r.createdAt ?? Date.now(),
          })
          existing.add(path)
        }
      }
    } catch { /* ignore */ }

    if (collected.length > 0) {
      set((s) => ({ documents: [...collected, ...s.documents] }))
      get()._persist()
    }
  },

  importObsidianVault: (files) => {
    const existing = new Set(get().documents.map((d) => d.path))
    const docs: KBDocument[] = []
    for (const f of files) {
      const rel = f.name.replace(/\\/g, '/')
      const path = `obsidian://${rel}`
      if (existing.has(path)) continue
      const signals = parseMarkdownSignals(f.content)
      docs.push({
        id: uid(),
        title: rel.split('/').pop()!.replace(/\.md$/i, ''),
        source: 'import',
        format: 'md',
        path,
        tags: uniq(['obsidian', ...signals.tags]),
        links: signals.links,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        preview: f.content,
        size: new Blob([f.content]).size,
      })
      existing.add(path)
    }
    if (docs.length > 0) {
      set((s) => ({ documents: [...docs, ...s.documents] }))
      get()._persist()
    }
  },

  importNotionZip: (files) => {
    const existing = new Set(get().documents.map((d) => d.title))
    const docs: KBDocument[] = []
    for (const f of files) {
      if (existing.has(f.name)) continue
      const ext = f.name.split('.').pop()?.toLowerCase()
      const format: DocFormat = ext === 'html' ? 'html' : ext === 'md' ? 'md' : 'txt'
      docs.push({
        id: uid(),
        title: f.name.replace(/\.(md|html|txt)$/i, ''),
        source: 'import',
        format,
        path: `notion://${f.name}`,
        tags: ['notion'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        preview: f.content,
        size: new Blob([f.content]).size,
      })
    }
    if (docs.length > 0) {
      set((s) => ({ documents: [...docs, ...s.documents] }))
      get()._persist()
    }
  },

  exportMarkdownFolder: () => {
    const docs = get().documents
    const mdDocs = docs.filter((d) => d.preview)
    if (mdDocs.length === 0) return

    // Simple: download each as a separate .md file via blob
    for (const doc of mdDocs) {
      const blob = new Blob([doc.preview ?? ''], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${doc.title}.md`
      a.click()
      URL.revokeObjectURL(url)
    }
  },

  _persist: () => {
    try {
      const { documents, tags } = get()
      localStorage.setItem(LS_KEY, JSON.stringify({ documents, tags }))
    } catch { /* quota exceeded */ }
  },

  _hydrate: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const data = JSON.parse(raw) as { documents?: KBDocument[]; tags?: KBTag[] }
        set({ documents: data.documents ?? [], tags: data.tags ?? [] })
      }
    } catch { /* ignore */ }
  },
}))
