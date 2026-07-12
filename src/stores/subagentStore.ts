// 子 agent 并行子任务 store（P8）：派发 / 停止 / 列出子任务，实时接收 subagent-event。
// 与 workbenchStore 的单主会话解耦——这是一个独立的并行任务层。
import { create } from 'zustand'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export type SubagentStatus = 'running' | 'done' | 'error' | 'stopped'

export interface SubagentSummary {
  id: string
  title: string
  status: SubagentStatus
  started_at: number
  cwd: string
  model: string
}

/** subagent-event payload：{ id, kind, ts, ...extra }，extra 随 kind 变化。 */
export interface SubagentEvent {
  id: string
  kind: 'output' | 'tool' | 'error' | 'done' | string
  ts: number
  text?: string
  tool?: string
  cmd?: string
  path?: string
  exit_code?: number
  output?: string
  message?: string
  [k: string]: unknown
}

interface SubagentState {
  agents: SubagentSummary[]
  eventsById: Record<string, SubagentEvent[]>
  selectedId: string | null
  listening: boolean
  init: () => Promise<void>
  refresh: () => Promise<void>
  spawn: (prompt: string, cwd: string, model: string) => Promise<void>
  stop: (id: string) => Promise<void>
  select: (id: string) => void
}

// 模块级、仅挂一次的事件监听句柄。
let _unlisten: (() => void) | null = null

export const useSubagentStore = create<SubagentState>((set, get) => ({
  agents: [],
  eventsById: {},
  selectedId: null,
  listening: false,

  init: async () => {
    if (get().listening || !isTauri || _unlisten) {
      // 已挂载监听时仍刷新一次列表，保证新打开的面板看到最新状态。
      void get().refresh()
      return
    }
    set({ listening: true })
    try {
      const { listen } = await import('@tauri-apps/api/event')
      _unlisten = await listen<SubagentEvent>('subagent-event', (evt) => {
        const p = evt.payload
        if (!p || !p.id) return
        set((s) => {
          const prev = s.eventsById[p.id]
          const list = prev ? [...prev, p] : [p]
          return { eventsById: { ...s.eventsById, [p.id]: list } }
        })
        // 完成/出错时刷新列表，更新状态徽章。
        if (p.kind === 'done' || p.kind === 'error') void get().refresh()
      })
    } catch (err) {
      set({ listening: false })
      console.warn('[subagentStore] 监听 subagent-event 失败:', err)
    }
    void get().refresh()
  },

  refresh: async () => {
    if (!isTauri) return
    try {
      const list = await tauriInvoke<SubagentSummary[]>('subagent_list')
      set({ agents: list })
    } catch (err) {
      console.warn('[subagentStore] 刷新子任务列表失败:', err)
    }
  },

  spawn: async (prompt, cwd, model) => {
    const id = await tauriInvoke<string>('subagent_spawn', { prompt, cwd, model })
    await get().refresh()
    set({ selectedId: id })
  },

  stop: async (id) => {
    await tauriInvoke<void>('subagent_stop', { id })
    await get().refresh()
  },

  select: (id) => set({ selectedId: id }),
}))
