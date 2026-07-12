// 全局 agent 任务注册表 —— 各板块(编码/办公/图像/科研/Auto/电商)把后台运行中的
// 任务登记到这里;Layout 底部的任务管理条据此显示"在跑 N 个任务"与明细。
// 契约(各板块 store 使用):
//   registerTask({ id, module, title })         任务开始时登记(status 默认 running)
//   updateTask(id, { status?, title?, detail? }) 进度/收尾时更新
//   removeTask(id)                               从列表移除(用户清除或无需保留时)
// 任务本体的执行/状态仍归各自 store;这里只是全局可见性层,组件卸载不影响。
import { create } from 'zustand'

export type TaskModule =
  | 'coding'
  | 'office'
  | 'image'
  | 'video'
  | 'science'
  | 'auto'
  | 'commerce'
  | 'mcp'
  | 'hooks'

export type GlobalTaskStatus = 'running' | 'done' | 'error'

export interface GlobalTask {
  id: string
  module: TaskModule
  title: string
  status: GlobalTaskStatus
  /** 可选的进度/阶段说明,一行。 */
  detail?: string
  startedAt: number
  updatedAt: number
}

export const MODULE_LABEL: Record<TaskModule, string> = {
  coding: '编码',
  office: '办公',
  image: '图像',
  video: '视频',
  science: '科研',
  auto: 'Auto',
  commerce: '电商',
  mcp: 'MCP',
  hooks: 'Hooks',
}

interface TaskRegistryState {
  tasks: GlobalTask[]
  registerTask: (t: { id: string; module: TaskModule; title: string; detail?: string }) => void
  updateTask: (
    id: string,
    patch: Partial<Pick<GlobalTask, 'status' | 'title' | 'detail'>>,
  ) => void
  removeTask: (id: string) => void
  /** 清掉所有已结束(done/error)的任务。 */
  clearFinished: () => void
}

export const useTaskRegistry = create<TaskRegistryState>((set) => ({
  tasks: [],

  registerTask: ({ id, module, title, detail }) =>
    set((s) => {
      const now = Date.now()
      const existing = s.tasks.find((t) => t.id === id)
      if (existing) {
        // 同 id 重复登记视为重新开始。
        return {
          tasks: s.tasks.map((t) =>
            t.id === id
              ? { ...t, module, title, detail, status: 'running' as const, updatedAt: now }
              : t,
          ),
        }
      }
      return {
        tasks: [
          ...s.tasks,
          { id, module, title, detail, status: 'running' as const, startedAt: now, updatedAt: now },
        ],
      }
    }),

  updateTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)),
    })),

  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  clearFinished: () =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'running') })),
}))

/** 运行中任务数(底部条徽章用)。 */
export function useRunningTaskCount(): number {
  return useTaskRegistry((s) => s.tasks.filter((t) => t.status === 'running').length)
}
