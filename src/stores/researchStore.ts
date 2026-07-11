import { create } from 'zustand'

// -- Tauri helper -----------------------------------------------------------

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

// -- Types (mirror Rust research.rs) ----------------------------------------

/** Mirrors Rust MdMeta (agent or skill markdown metadata). */
export interface MdMeta {
  name: string
  title: string
  description: string
  category: string
  path: string
}

/** Mirrors Rust PipelineInfo. */
export interface PipelineInfo {
  id: string
  name: string
  description: string
  steps: string[]
  source: string
}

/** Mirrors Rust RunArtifact. */
export interface RunArtifact {
  kind: string
  path: string
}

/** Mirrors Rust DashboardStage. */
export interface DashboardStage {
  title: string
  status: string
  progress: number
}

/** Mirrors Rust DashboardRun. */
export interface DashboardRun {
  id: string
  title: string
  status: string
  created_at: string
  updated_at: string
  current_stage: string
  artifacts: RunArtifact[]
  stages: DashboardStage[]
}

/** Mirrors Rust SkillStat. */
export interface SkillStat {
  name: string
  status: string
  runs: number
  successes: number
  last_run: string | null
  summary: string | null
}

/** Mirrors Rust LogEntry. */
export interface LogEntry {
  skill: string
  status: string
  project: string
  finished: string
  summary: string
}

/** Mirrors Rust Dashboard. */
export interface Dashboard {
  skills: SkillStat[]
  runs: DashboardRun[]
  logs: LogEntry[]
  kb_total_papers: number
  kb_total_size_mb: number
  kb_last_scan: string | null
}

/** Mirrors Rust ResearchRoots. */
export interface ResearchRoots {
  agents_root: string
  skills_root: string
}

/** Mirrors Rust RunLaunch. */
export interface RunLaunch {
  cwd: string
  prompt: string
  label: string
}

/** Mirrors Rust litsearch::LitPaper (unified paper across sources). */
export interface LitPaper {
  id: string
  title: string
  authors: string[]
  year: string
  abstract: string
  url: string
  source: string
}

export type ResearchTab = 'agents' | 'skills' | 'pipelines' | 'dashboard' | 'lit'

// -- Store ------------------------------------------------------------------

interface ResearchStore {
  roots: ResearchRoots | null

  agents: MdMeta[]
  agentsLoaded: boolean
  agentsLoading: boolean

  skills: MdMeta[]
  skillsLoaded: boolean
  skillsLoading: boolean

  pipelines: PipelineInfo[]
  pipelinesLoaded: boolean
  pipelinesLoading: boolean

  dashboard: Dashboard | null
  dashboardLoading: boolean

  error: string | null
  notice: string | null

  loadRoots: () => Promise<void>
  loadAgents: () => Promise<void>
  loadSkills: () => Promise<void>
  loadPipelines: () => Promise<void>
  loadDashboard: () => Promise<void>

  readAgent: (path: string) => Promise<string>
  writeAgent: (path: string, content: string) => Promise<void>
  readSkill: (path: string) => Promise<string>
  writeSkill: (path: string, content: string) => Promise<void>
  readRunOutput: (path: string) => Promise<string>
  runPipeline: (id: string, input?: string) => Promise<RunLaunch>

  litSearch: (query: string, source: string, limit: number) => Promise<LitPaper[]>
  litAnalyze: (
    papers: LitPaper[],
    instruction: string,
    model: string,
    providerId: string | null,
  ) => Promise<string>

  clearNotice: () => void
}

export const useResearchStore = create<ResearchStore>((set) => ({
  roots: null,

  agents: [],
  agentsLoaded: false,
  agentsLoading: false,

  skills: [],
  skillsLoaded: false,
  skillsLoading: false,

  pipelines: [],
  pipelinesLoaded: false,
  pipelinesLoading: false,

  dashboard: null,
  dashboardLoading: false,

  error: null,
  notice: null,

  loadRoots: async () => {
    if (!isTauri) return
    try {
      const roots = await tauriInvoke<ResearchRoots>('research_roots')
      set({ roots })
    } catch (e) {
      set({ error: '读取源目录失败：' + String(e) })
    }
  },

  loadAgents: async () => {
    if (!isTauri) return
    set({ agentsLoading: true, error: null })
    try {
      const agents = await tauriInvoke<MdMeta[]>('research_agents')
      set({ agents, agentsLoaded: true, agentsLoading: false })
    } catch (e) {
      set({ agentsLoading: false, error: 'Agent 扫描失败：' + String(e) })
    }
  },

  loadSkills: async () => {
    if (!isTauri) return
    set({ skillsLoading: true, error: null })
    try {
      const skills = await tauriInvoke<MdMeta[]>('research_skills')
      set({ skills, skillsLoaded: true, skillsLoading: false })
    } catch (e) {
      set({ skillsLoading: false, error: 'Skill 扫描失败：' + String(e) })
    }
  },

  loadPipelines: async () => {
    if (!isTauri) return
    set({ pipelinesLoading: true, error: null })
    try {
      const pipelines = await tauriInvoke<PipelineInfo[]>('research_pipelines')
      set({ pipelines, pipelinesLoaded: true, pipelinesLoading: false })
    } catch (e) {
      set({ pipelinesLoading: false, error: '流水线读取失败：' + String(e) })
    }
  },

  loadDashboard: async () => {
    if (!isTauri) return
    set({ dashboardLoading: true, error: null })
    try {
      const dashboard = await tauriInvoke<Dashboard>('research_dashboard')
      set({ dashboard, dashboardLoading: false })
    } catch (e) {
      set({ dashboardLoading: false, error: '仪表盘加载失败：' + String(e) })
    }
  },

  readAgent: (path) => tauriInvoke<string>('research_agent_read', { path }),
  writeAgent: (path, content) =>
    tauriInvoke<void>('research_agent_write', { path, content }),
  readSkill: (path) => tauriInvoke<string>('research_skill_read', { path }),
  writeSkill: (path, content) =>
    tauriInvoke<void>('research_skill_write', { path, content }),
  readRunOutput: (path) =>
    tauriInvoke<string>('research_run_output_read', { path }),
  runPipeline: (id, input) =>
    tauriInvoke<RunLaunch>('research_run_pipeline', { id, input: input ?? null }),

  litSearch: (query, source, limit) =>
    tauriInvoke<LitPaper[]>('lit_search', { query, source, limit }),
  litAnalyze: (papers, instruction, model, providerId) =>
    tauriInvoke<string>('lit_analyze', {
      papers,
      instruction,
      model,
      providerId,
    }),

  clearNotice: () => set({ notice: null, error: null }),
}))
