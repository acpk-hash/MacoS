import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanvasMode = 'mindmap' | 'freeform'

export interface CanvasNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
  /** For mind map: parent node id. null = root. */
  parentId: string | null
  shape: 'rect' | 'ellipse'
  color: string
}

export interface CanvasEdge {
  id: string
  sourceId: string
  targetId: string
  label: string
}

export interface CanvasProject {
  id: string
  name: string
  mode: CanvasMode
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  createdAt: number
  updatedAt: number
  /** Viewport pan offset. */
  panX: number
  panY: number
  zoom: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CanvasState {
  projects: CanvasProject[]
  activeProjectId: string | null
  mode: CanvasMode

  setMode: (m: CanvasMode) => void
  setActiveProject: (id: string | null) => void

  createProject: (name: string, mode: CanvasMode) => string
  deleteProject: (id: string) => void
  renameProject: (id: string, name: string) => void

  addNode: (node: CanvasNode) => void
  updateNode: (id: string, patch: Partial<CanvasNode>) => void
  removeNode: (id: string) => void

  addEdge: (edge: CanvasEdge) => void
  updateEdge: (id: string, patch: Partial<CanvasEdge>) => void
  removeEdge: (id: string) => void

  setPan: (x: number, y: number) => void
  setZoom: (z: number) => void

  /** Get the active project (convenience). */
  getActiveProject: () => CanvasProject | undefined

  _persist: () => void
  _hydrate: () => void
}

const LS_KEY = 'iris.canvas.v1'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function mutateProject(
  projects: CanvasProject[],
  id: string | null,
  fn: (p: CanvasProject) => CanvasProject,
): CanvasProject[] {
  if (!id) return projects
  return projects.map((p) => (p.id === id ? fn({ ...p, updatedAt: Date.now() }) : p))
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  mode: 'mindmap',

  setMode: (m) => set({ mode: m }),
  setActiveProject: (id) => set({ activeProjectId: id }),

  createProject: (name, mode) => {
    const id = uid()
    const root: CanvasNode = {
      id: uid(),
      x: 400,
      y: 300,
      width: 140,
      height: 48,
      text: name || '中心主题',
      parentId: null,
      shape: 'rect',
      color: '#6366f1',
    }
    const project: CanvasProject = {
      id,
      name,
      mode,
      nodes: mode === 'mindmap' ? [root] : [],
      edges: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      panX: 0,
      panY: 0,
      zoom: 1,
    }
    set((s) => ({
      projects: [project, ...s.projects],
      activeProjectId: id,
      mode,
    }))
    get()._persist()
    return id
  },

  deleteProject: (id) => {
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
    }))
    get()._persist()
  },

  renameProject: (id, name) => {
    set((s) => ({
      projects: mutateProject(s.projects, id, (p) => ({ ...p, name })),
    }))
    get()._persist()
  },

  addNode: (node) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({
        ...p,
        nodes: [...p.nodes, node],
      })),
    }))
    get()._persist()
  },

  updateNode: (id, patch) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({
        ...p,
        nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      })),
    }))
    get()._persist()
  },

  removeNode: (id) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({
        ...p,
        nodes: p.nodes.filter((n) => n.id !== id),
        edges: p.edges.filter((e) => e.sourceId !== id && e.targetId !== id),
      })),
    }))
    get()._persist()
  },

  addEdge: (edge) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({
        ...p,
        edges: [...p.edges, edge],
      })),
    }))
    get()._persist()
  },

  updateEdge: (id, patch) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({
        ...p,
        edges: p.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      })),
    }))
    get()._persist()
  },

  removeEdge: (id) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({
        ...p,
        edges: p.edges.filter((e) => e.id !== id),
      })),
    }))
    get()._persist()
  },

  setPan: (x, y) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({ ...p, panX: x, panY: y })),
    }))
  },

  setZoom: (z) => {
    const pid = get().activeProjectId
    set((s) => ({
      projects: mutateProject(s.projects, pid, (p) => ({ ...p, zoom: z })),
    }))
  },

  getActiveProject: () => {
    const { projects, activeProjectId } = get()
    return projects.find((p) => p.id === activeProjectId)
  },

  _persist: () => {
    try {
      const { projects } = get()
      localStorage.setItem(LS_KEY, JSON.stringify({ projects }))
    } catch { /* quota */ }
  },

  _hydrate: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const data = JSON.parse(raw) as { projects?: CanvasProject[] }
        if (data.projects?.length) {
          set({ projects: data.projects })
        }
      }
    } catch { /* ignore */ }
  },
}))
