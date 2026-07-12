import { create } from 'zustand'

// -- Tauri helpers -----------------------------------------------------------

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

// -- Types (mirrors Rust db/kb.rs structs) ------------------------------------

/** Mirrors Rust PaperSummary — lightweight row from kb_list_papers. */
export interface PaperSummary {
  id: string
  title: string | null
  authors: string | null
  year: number | null
  venue: string | null
  category_id: string | null
  starred: number
  file_size: number | null
  added_at: number | null
  orig_filename: string | null
}

/** Mirrors Rust TagRef — tag reference attached to a paper. */
export interface TagRef {
  id: string
  name: string
  color: string | null
}

/** Mirrors Rust Paper — full paper record with tags list. */
export interface Paper {
  id: string
  title: string | null
  authors: string | null
  year: number | null
  venue: string | null
  abstract: string | null
  doi: string | null
  arxiv_id: string | null
  eprint_id: string | null
  orig_filename: string | null
  file_path: string | null
  file_size: number | null
  category_id: string | null
  starred: number
  notes: string | null
  managed: number
  added_at: number | null
  updated_at: number | null
  tags: TagRef[]
}

/** Mirrors Rust Category. */
export interface Category {
  id: string
  name: string
  parent_id: string | null
  color: string | null
  sort: number
}

/** Mirrors Rust Tag. */
export interface Tag {
  id: string
  name: string
  color: string | null
}

/** Mirrors Rust ScanResult. */
export interface ScanResult {
  found: number
  added: number
}

/** Mirrors Rust RenamePreview — preview of a planned rename. */
export interface RenamePreview {
  id: string
  old_name: string
  new_name: string
}

/** Mirrors Rust ApplyItem — one item in a batch-apply rename request. */
export interface ApplyItem {
  id: string
  new_name: string
}

/** Mirrors Rust FailedItem — per-item failure in an apply result. */
export interface FailedItem {
  id: string
  error: string
}

/** Mirrors Rust ApplyResult — result of a batch rename-apply operation. */
export interface ApplyResult {
  applied: number
  failed: FailedItem[]
}

// -- Filter ------------------------------------------------------------------

export interface PaperFilter {
  categoryId?: string | null
  tagId?: string | null
  query?: string | null
  starred?: boolean | null
}

// -- Store interface ---------------------------------------------------------

interface KbStore {
  papers: PaperSummary[]
  papersLoading: boolean
  categories: Category[]
  categoriesLoading: boolean
  tags: Tag[]
  tagsLoading: boolean

  selectedPaperId: string | null
  selectedPaper: Paper | null
  selectedPaperLoading: boolean

  activeCategoryId: string | null
  activeTagId: string | null
  query: string

  kbRoot: string | null

  error: string | null
  notice: string | null

  // Paper actions
  loadPapers: (filter?: PaperFilter) => Promise<void>
  getPaper: (id: string) => Promise<void>
  importDir: (dir: string, recursive: boolean) => Promise<ScanResult>
  uploadPaper: (srcPath: string, mode: string, categoryId?: string | null) => Promise<string>
  updateMetadata: (
    id: string,
    fields: {
      title?: string | null
      authors?: string | null
      year?: number | null
      venue?: string | null
      doi?: string | null
      notes?: string | null
      starred?: boolean | null
    },
  ) => Promise<void>
  setCategory: (paperId: string, categoryId: string | null) => Promise<void>
  deletePaper: (id: string, deleteFile: boolean) => Promise<void>

  // File management actions
  renameFile: (id: string, newName: string) => Promise<string>
  moveFile: (id: string, destDir: string) => Promise<string>
  normalizePreview: (paperIds: string[], template: string) => Promise<RenamePreview[]>
  normalizeApply: (items: ApplyItem[]) => Promise<ApplyResult>
  renameUndo: (paperId: string) => Promise<string>

  // Watch actions (backend implemented in parallel task; silently no-ops until landed)
  watchStart: () => Promise<void>
  watchStop: () => Promise<void>

  // Category actions
  loadCategories: () => Promise<void>
  addCategory: (name: string, parentId?: string | null, color?: string | null) => Promise<string>
  updateCategory: (
    id: string,
    fields: {
      name?: string | null
      parentId?: string | null
      color?: string | null
      sort?: number | null
    },
  ) => Promise<void>
  deleteCategory: (id: string) => Promise<void>

  // Tag actions
  loadTags: () => Promise<void>
  addTags: (paperId: string, tags: string[]) => Promise<void>
  removeTag: (paperId: string, tagId: string) => Promise<void>

  // KB root
  rootGet: () => Promise<string>
  rootSet: (path: string) => Promise<void>

  // UI helpers
  selectPaper: (id: string | null) => void
  setActiveCategoryId: (id: string | null) => void
  setActiveTagId: (id: string | null) => void
  setQuery: (q: string) => void
  clearNotice: () => void

  // Init (registers kb-event listener once)
  init: () => Promise<void>
}

// -- Module-level watch guard (register kb-event listener only once) ----------

let _kbEventUnlisten: (() => void) | null = null
let _kbEventListening = false
let _kbEventDebounceTimer: ReturnType<typeof setTimeout> | null = null

// -- Store -------------------------------------------------------------------

export const useKbStore = create<KbStore>((set, get) => ({
  papers: [],
  papersLoading: false,
  categories: [],
  categoriesLoading: false,
  tags: [],
  tagsLoading: false,

  selectedPaperId: null,
  selectedPaper: null,
  selectedPaperLoading: false,

  activeCategoryId: null,
  activeTagId: null,
  query: '',

  kbRoot: null,

  error: null,
  notice: null,

  // -- Init (kb-event listener) ----------------------------------------------

  init: async () => {
    if (!isTauri) return
    if (_kbEventListening) return
    _kbEventListening = true
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const unlisten = await listen<{ kind: string }>('kb-event', (_evt) => {
        // Debounce: coalesce rapid filesystem events into a single list reload
        if (_kbEventDebounceTimer) clearTimeout(_kbEventDebounceTimer)
        _kbEventDebounceTimer = setTimeout(() => {
          void get().loadPapers()
        }, 300)
      })
      _kbEventUnlisten = unlisten
    } catch {
      _kbEventListening = false
    }
  },

  // -- Papers ----------------------------------------------------------------

  loadPapers: async (filter?: PaperFilter) => {
    if (!isTauri) return
    set({ papersLoading: true, error: null })
    try {
      const papers = await tauriInvoke<PaperSummary[]>('kb_list_papers', {
        categoryId: filter?.categoryId !== undefined ? filter.categoryId : get().activeCategoryId,
        tagId: filter?.tagId !== undefined ? filter.tagId : get().activeTagId,
        query: filter?.query !== undefined ? filter.query : (get().query || null),
        starred: filter?.starred !== undefined ? filter.starred : null,
      })
      set({ papers, papersLoading: false })
    } catch (e) {
      set({ papersLoading: false, error: '加载论文失败：' + String(e) })
    }
  },

  getPaper: async (id: string) => {
    if (!isTauri) return
    set({ selectedPaperLoading: true })
    try {
      const paper = await tauriInvoke<Paper | null>('kb_get_paper', { id })
      set({ selectedPaper: paper, selectedPaperLoading: false })
    } catch (e) {
      set({ selectedPaperLoading: false, error: '读取论文失败：' + String(e) })
    }
  },

  importDir: async (dir: string, recursive: boolean): Promise<ScanResult> => {
    if (!isTauri) return { found: 0, added: 0 }
    return tauriInvoke<ScanResult>('kb_import_dir', { dir, recursive })
  },

  uploadPaper: async (srcPath: string, mode: string, categoryId?: string | null): Promise<string> => {
    if (!isTauri) return ''
    return tauriInvoke<string>('kb_upload_paper', {
      srcPath,
      mode,
      categoryId: categoryId ?? null,
    })
  },

  updateMetadata: async (id, fields) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_update_metadata', {
      id,
      title: fields.title ?? null,
      authors: fields.authors ?? null,
      year: fields.year ?? null,
      venue: fields.venue ?? null,
      doi: fields.doi ?? null,
      notes: fields.notes ?? null,
      starred: fields.starred ?? null,
    })
    if (get().selectedPaperId === id) {
      await get().getPaper(id)
    }
  },

  setCategory: async (paperId, categoryId) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_set_category', { paperId, categoryId })
    if (get().selectedPaperId === paperId) {
      await get().getPaper(paperId)
    }
  },

  deletePaper: async (id, deleteFile) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_delete_paper', { id, deleteFile })
    set((s) => ({
      papers: s.papers.filter((p) => p.id !== id),
      selectedPaperId: s.selectedPaperId === id ? null : s.selectedPaperId,
      selectedPaper: s.selectedPaper?.id === id ? null : s.selectedPaper,
    }))
  },

  // -- File management -------------------------------------------------------

  renameFile: async (id: string, newName: string): Promise<string> => {
    if (!isTauri) return ''
    const result = await tauriInvoke<string>('kb_rename_file', { id, newName })
    await get().loadPapers()
    if (get().selectedPaperId === id) {
      await get().getPaper(id)
    }
    return result
  },

  moveFile: async (id: string, destDir: string): Promise<string> => {
    if (!isTauri) return ''
    const result = await tauriInvoke<string>('kb_move_file', { id, destDir })
    await get().loadPapers()
    if (get().selectedPaperId === id) {
      await get().getPaper(id)
    }
    return result
  },

  normalizePreview: async (paperIds: string[], template: string): Promise<RenamePreview[]> => {
    if (!isTauri) return []
    return tauriInvoke<RenamePreview[]>('kb_normalize_preview', { paperIds, template })
  },

  normalizeApply: async (items: ApplyItem[]): Promise<ApplyResult> => {
    if (!isTauri) return { applied: 0, failed: [] }
    const result = await tauriInvoke<ApplyResult>('kb_normalize_apply', { items })
    await get().loadPapers()
    return result
  },

  renameUndo: async (paperId: string): Promise<string> => {
    if (!isTauri) return ''
    const result = await tauriInvoke<string>('kb_rename_undo', { paperId })
    await get().loadPapers()
    if (get().selectedPaperId === paperId) {
      await get().getPaper(paperId)
    }
    return result
  },

  watchStart: async () => {
    if (!isTauri) return
    try {
      await tauriInvoke<void>('kb_watch_start')
    } catch {
      // Backend not yet implemented in parallel task; silently ignore
    }
  },

  watchStop: async () => {
    if (!isTauri) return
    try {
      await tauriInvoke<void>('kb_watch_stop')
    } catch {
      // Backend not yet implemented in parallel task; silently ignore
    }
  },

  // -- Categories ------------------------------------------------------------

  loadCategories: async () => {
    if (!isTauri) return
    set({ categoriesLoading: true })
    try {
      const categories = await tauriInvoke<Category[]>('kb_list_categories')
      set({ categories, categoriesLoading: false })
    } catch (e) {
      set({ categoriesLoading: false, error: '加载分类失败：' + String(e) })
    }
  },

  addCategory: async (name, parentId, color): Promise<string> => {
    if (!isTauri) return ''
    const id = await tauriInvoke<string>('kb_add_category', {
      name,
      parentId: parentId ?? null,
      color: color ?? null,
    })
    await get().loadCategories()
    return id
  },

  updateCategory: async (id, fields) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_update_category', {
      id,
      name: fields.name ?? null,
      parentId: fields.parentId !== undefined ? fields.parentId : undefined,
      color: fields.color !== undefined ? fields.color : undefined,
      sort: fields.sort ?? null,
    })
    await get().loadCategories()
  },

  deleteCategory: async (id) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_delete_category', { id })
    await get().loadCategories()
    if (get().activeCategoryId === id) {
      set({ activeCategoryId: null })
    }
  },

  // -- Tags ------------------------------------------------------------------

  loadTags: async () => {
    if (!isTauri) return
    set({ tagsLoading: true })
    try {
      const tags = await tauriInvoke<Tag[]>('kb_list_tags')
      set({ tags, tagsLoading: false })
    } catch (e) {
      set({ tagsLoading: false, error: '加载标签失败：' + String(e) })
    }
  },

  addTags: async (paperId, tags) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_add_tags', { paperId, tags })
    await get().loadTags()
    if (get().selectedPaperId === paperId) {
      await get().getPaper(paperId)
    }
  },

  removeTag: async (paperId, tagId) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_remove_tag', { paperId, tagId })
    if (get().selectedPaperId === paperId) {
      await get().getPaper(paperId)
    }
  },

  // -- KB root ---------------------------------------------------------------

  rootGet: async (): Promise<string> => {
    if (!isTauri) return ''
    const path = await tauriInvoke<string>('kb_root_get')
    set({ kbRoot: path })
    return path
  },

  rootSet: async (path) => {
    if (!isTauri) return
    await tauriInvoke<void>('kb_root_set', { path })
    set({ kbRoot: path })
  },

  // -- UI helpers ------------------------------------------------------------

  selectPaper: (id) => {
    set({ selectedPaperId: id, selectedPaper: null })
    if (id) void get().getPaper(id)
  },

  setActiveCategoryId: (id) => {
    set({ activeCategoryId: id })
  },

  setActiveTagId: (id) => {
    set({ activeTagId: id })
  },

  setQuery: (q) => {
    set({ query: q })
  },

  clearNotice: () => set({ notice: null, error: null }),
}))

// Cleanup helper exported for testing / HMR teardown
export function kbStoreCleanup() {
  if (_kbEventUnlisten) {
    _kbEventUnlisten()
    _kbEventUnlisten = null
    _kbEventListening = false
  }
}
