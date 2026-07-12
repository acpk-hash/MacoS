import { create } from 'zustand'
import { useStudioStore } from './studioStore'
import { useTaskRegistry } from './taskRegistryStore'

// 视频工作台状态中心。
// 两个模式：
//   1. 生成模式（text-to-video）：接入 aggModels kind==='video'，暂无后端命令则 UI 就绪。
//   2. 处理模式：上传本地视频 → AI chat 分析/处理（chat_send 通道）→ 结果渲染/导出。
//
// 后端能力事实（src-tauri/src/studio.rs 只读核对）：
//   - 无 video_generate / sora 命令，仅 image_generate/image_edit。
//   - studio_capabilities → { video: bool }（probe_video 探测 /v1/videos 端点）。
//   - gen_media 表 kind 字段为 TEXT，可存 'video'；media_list(kind='video') 可查。
//   - chat_send 支持 image 附件多模态（build_user_content）。
//   - export_text_file 可写 UTF-8 文件到磁盘。
//   因此：生成模式 UI 就绪但可能无可用模型；处理模式走 chat 通道。

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

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'id-' + Math.random().toString(36).slice(2)
}

// ── 视频文件信息 ──────────────────────────────────────────────────────────────

export interface VideoFileInfo {
  /** 本地绝对路径。 */
  path: string
  name: string
  /** 字节数。 */
  size: number
  /** 时长(秒)，onLoadedMetadata 后填入。 */
  duration: number | null
  /** convertFileSrc 生成的可预览 URL；大视频(>50MB)为 null。 */
  previewUrl: string | null
}

// ── 处理任务 ──────────────────────────────────────────────────────────────────

export interface ProcessTask {
  id: string
  /** 用户的指令/prompt。 */
  instruction: string
  /** streaming | done | error */
  status: 'streaming' | 'done' | 'error'
  /** 模型回复（流式累积）。 */
  reply: string
  /** chat session id（用于 stop）。 */
  sessionId: string
  createdAt: number
}

// ── Store ─────────────────────────────────────────────────────────────────────

export type VideoTab = 'generate' | 'process'

interface VideoStore {
  tab: VideoTab
  setTab: (t: VideoTab) => void

  // ── 生成模式 ──
  genPrompt: string
  setGenPrompt: (v: string) => void
  genModel: string
  genProviderId: string
  setGenSel: (providerId: string, modelId: string) => void

  // ── 处理模式 ──
  video: VideoFileInfo | null
  setVideo: (v: VideoFileInfo | null) => void
  setDuration: (d: number) => void

  tasks: ProcessTask[]
  /** 处理模式的 chat 模型选择。 */
  procModel: string
  procProviderId: string
  setProcSel: (providerId: string, modelId: string) => void

  /** 发送处理指令（chat 通道，流式）。 */
  sendInstruction: (instruction: string) => Promise<void>
  /** 停止当前流式任务。 */
  stopTask: (taskId: string) => Promise<void>
  /** 移除已完成的任务记录。 */
  removeTask: (taskId: string) => void

  /** 导出任务结果到文件。 */
  exportResult: (taskId: string, format: 'md' | 'srt' | 'txt') => Promise<void>
}

export const useVideoStore = create<VideoStore>((set, get) => ({
  tab: 'process',
  setTab: (t) => set({ tab: t }),

  // ── 生成 ──
  genPrompt: '',
  setGenPrompt: (v) => set({ genPrompt: v }),
  genModel: '',
  genProviderId: '',
  setGenSel: (providerId, modelId) =>
    set({ genProviderId: providerId, genModel: modelId }),

  // ── 处理 ──
  video: null,
  setVideo: (v) => set({ video: v }),
  setDuration: (d) =>
    set((s) => (s.video ? { video: { ...s.video, duration: d } } : {})),

  tasks: [],
  procModel: '',
  procProviderId: '',
  setProcSel: (providerId, modelId) =>
    set({ procProviderId: providerId, procModel: modelId }),

  sendInstruction: async (instruction) => {
    if (!isTauri) return
    const { video, procModel, procProviderId } = get()
    if (!video || !procModel || !instruction.trim()) return

    // 确保 studioStore 模型已加载。
    const studio = useStudioStore.getState()
    if (!studio.modelsLoaded) await studio.loadModels()

    const taskId = 'vid-proc-' + uuid()
    const sessionId = uuid()

    const task: ProcessTask = {
      id: taskId,
      instruction: instruction.trim(),
      status: 'streaming',
      reply: '',
      sessionId,
      createdAt: Date.now(),
    }
    set((s) => ({ tasks: [task, ...s.tasks] }))

    // 注册全局任务。
    const reg = useTaskRegistry.getState()
    reg.registerTask({
      id: taskId,
      module: 'video',
      title: '视频分析',
      detail: instruction.trim().slice(0, 40),
    })

    // 构造视频元信息上下文。
    const sizeMB = (video.size / (1024 * 1024)).toFixed(1)
    const durStr = video.duration != null
      ? `${Math.floor(video.duration / 60)}分${Math.round(video.duration % 60)}秒`
      : '未知'
    const context = [
      `【视频文件信息】`,
      `文件名: ${video.name}`,
      `大小: ${sizeMB} MB`,
      `时长: ${durStr}`,
      '',
      `【用户指令】`,
      instruction.trim(),
    ].join('\n')

    // 监听 studio-event 获取流式回复。
    let unlisten: (() => void) | null = null
    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{
        type: string
        session_id?: string
        message_id?: string
        text?: string
        status?: string
        message?: string
      }>('studio-event', (evt) => {
        const p = evt.payload
        if (p.session_id !== sessionId) return
        if (p.type === 'delta' && p.text) {
          set((s) => ({
            tasks: s.tasks.map((t) =>
              t.id === taskId ? { ...t, reply: t.reply + p.text } : t,
            ),
          }))
        } else if (p.type === 'done') {
          set((s) => ({
            tasks: s.tasks.map((t) =>
              t.id === taskId
                ? { ...t, status: 'done', reply: p.text ?? t.reply }
                : t,
            ),
          }))
          reg.updateTask(taskId, { status: 'done' })
          unlisten?.()
        } else if (p.type === 'error') {
          set((s) => ({
            tasks: s.tasks.map((t) =>
              t.id === taskId
                ? { ...t, status: 'error', reply: p.message ?? '分析出错' }
                : t,
            ),
          }))
          reg.updateTask(taskId, { status: 'error', detail: p.message })
          unlisten?.()
        }
      })

      await tauriInvoke<string>('chat_send', {
        sessionId,
        userContent: context,
        attachments: [],
        model: procModel,
        providerId: procProviderId || null,
      })
    } catch (e) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === taskId ? { ...t, status: 'error', reply: String(e) } : t,
        ),
      }))
      reg.updateTask(taskId, { status: 'error', detail: String(e) })
      unlisten?.()
    }

    // 清理临时会话（不保留在聊天列表里）。
    try {
      await tauriInvoke<void>('chat_sessions_delete', { sessionId })
    } catch { /* ignore */ }
    void useStudioStore.getState().loadSessions()
  },

  stopTask: async (taskId) => {
    const task = get().tasks.find((t) => t.id === taskId)
    if (!task || task.status !== 'streaming') return
    try {
      await tauriInvoke<void>('chat_stop', { sessionId: task.sessionId })
    } catch { /* ignore */ }
  },

  removeTask: (taskId) =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) })),

  exportResult: async (taskId, format) => {
    if (!isTauri) return
    const task = get().tasks.find((t) => t.id === taskId)
    if (!task || !task.reply) return

    const { save } = await import('@tauri-apps/plugin-dialog')
    const ext = format
    const dest = await save({
      defaultPath: `video-result-${taskId.slice(0, 8)}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    if (!dest) return

    try {
      await tauriInvoke<void>('export_text_file', {
        path: dest,
        content: task.reply,
      })
    } catch (e) {
      console.warn('[videoStore] export failed:', e)
    }
  },
}))
