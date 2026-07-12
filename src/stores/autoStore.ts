// autoStore — Auto 板块（open-science 全流水线自动科研工作台）的全局状态。
//
// 设计要点：
// - 运行状态/实时日志/阶段推进/产物/历史台账全部放在本 store（zustand，
//   模块级单例）——离开页面组件卸载也不丢，回来接着看（后台不丢）。
// - os-event 监听器注册在模块级（app 生命周期内一次），产物 8s 轮询计时器
//   也在模块级，与组件挂载无关。
// - 运行挂全局 taskRegistryStore（module:'auto'），Layout 底部任务条可见。
// - 历史台账持久化 localStorage（topic/model/workspace/起止/状态/产物数/
//   日志尾部），配置条与检查器 UI 状态同样持久化。
//
// 后端契约见 src-tauri/src/openscience.rs：
//   os_detect / os_install / os_prepare / os_run / os_stop / os_artifacts /
//   os_read_text + `os-event` 事件流（install_output/install_done/
//   run_output/run_stderr/run_done）。
import { create } from 'zustand'
import { useTaskRegistry } from './taskRegistryStore'

// ── 后端契约类型 ──────────────────────────────────────────────────────────────

export interface OsDetect {
  installed: boolean
  version: string | null
  node: boolean
}

export interface OsArtifact {
  name: string
  path: string
  kind: 'pdf' | 'md' | 'tex' | 'jsonl' | string
  size: number
  mtime: number
}

interface OsEventPayload {
  kind: string
  line?: string
  code?: number
  runId?: string
  stopped?: boolean
  stderr_tail?: string
}

// ── 阶段流水线 ────────────────────────────────────────────────────────────────

export type PhaseId = 'explore' | 'literature-review' | 'critique' | 'write' | 'reviewer'

export const PHASES: ReadonlyArray<{ id: PhaseId; label: string }> = [
  { id: 'explore', label: '探索' },
  { id: 'literature-review', label: '文献综述' },
  { id: 'critique', label: '实验评审' },
  { id: 'write', label: '论文撰写' },
  { id: 'reviewer', label: '终审' },
]

export type PhaseStatus = 'pending' | 'active' | 'done' | 'error'

export interface PhaseState {
  status: PhaseStatus
  startedAt: number | null
  endedAt: number | null
}

export type PhaseMap = Record<PhaseId, PhaseState>

function freshPhases(): PhaseMap {
  const m = {} as PhaseMap
  for (const p of PHASES) m[p.id] = { status: 'pending', startedAt: null, endedAt: null }
  return m
}

/**
 * 判断一行事件流是否点名了某个 subagent 阶段。
 * 比旧 AutoResearchTab 的裸 includes 更严：--format json 下 subagent 名总以
 * JSON 字符串（带引号）或 @mention 形式出现，裸词（如正文里的 "write"）不算。
 */
function lineHitsPhase(line: string, id: PhaseId): boolean {
  return line.includes(`"${id}"`) || line.includes(`@${id}`)
}

// ── 日志行 ────────────────────────────────────────────────────────────────────

export interface LogLine {
  id: number
  /** 原始行（JSON 事件或 stderr 文本）。 */
  raw: string
  /** 美化后的展示文本（JSON 提取 type/text）。 */
  text: string
  /** 该行归属的阶段（写入时的活跃阶段），供阶段过滤。 */
  phase: PhaseId | null
  stderr: boolean
  ts: number
}

/** 把一行 JSON 事件转成可读摘要；解析失败原样截断返回。 */
export function prettyLine(raw: string): string {
  try {
    const ev = JSON.parse(raw) as {
      type?: string
      part?: { type?: string; text?: string; tool?: string; name?: string }
    }
    const part = ev.part ?? {}
    if (ev.type === 'text' && part.text) return part.text
    if (ev.type === 'step_start') return '── 步骤开始 ──'
    if (ev.type === 'step_finish') return '── 步骤完成 ──'
    if (part.type && part.type.includes('tool')) {
      return `[工具] ${part.tool ?? part.name ?? part.type}`
    }
    if (ev.type) return `[${ev.type}]`
  } catch {
    /* 非 JSON（banner/警告）原样展示 */
  }
  return raw.length > 600 ? raw.slice(0, 600) + '…' : raw
}

// ── 运行历史台账 ──────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'done' | 'error' | 'stopped'

export interface AutoRunRecord {
  id: string
  topic: string
  workspace: string
  providerId: string
  model: string
  startedAt: number
  endedAt: number | null
  status: RunStatus
  artifactCount: number
  /** 结束时截取的日志尾部（美化文本），行展开时回看。 */
  logTail: string[]
}

// ── 持久化 ────────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'iris.auto.history.v1'
const CONFIG_KEY = 'iris.auto.config.v1'
const UI_KEY = 'iris.auto.ui.v1'

interface ConfigPersist {
  workspace: string
  topic: string
  providerId: string | null
  model: string | null
}

interface UiPersist {
  inspectorOpen: boolean
  inspectorWidth: number
  historyOpen: boolean
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* localStorage 不可用时仅内存生效 */
  }
}

// ── Tauri helpers ─────────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── 模块级运行时簿记（与 React 状态解耦） ─────────────────────────────────────

let initialized = false
let listenerRegistered = false
let lineSeq = 0
/** os_run invoke 尚未返回 runId 时先缓冲事件，返回后 flush（防早到事件丢失）。 */
let awaitingRun = false
let pendingLines: Array<{ line: string; stderr: boolean }> = []
interface PendingDone {
  code: number
  stopped: boolean
  stderrTail: string | null
}
let pendingDone: PendingDone | null = null

/** 取走并清空 pendingDone（经函数出入避免 TS 对模块级 let 的过度收窄）。 */
function takePendingDone(): PendingDone | null {
  const d = pendingDone
  pendingDone = null
  return d
}
let pollTimer: ReturnType<typeof setInterval> | null = null

const ARTIFACT_POLL_MS = 8000
const LOG_CAP = 1600
const LOG_TRIM_TO = 1200
const HISTORY_TAIL_LINES = 120
const HISTORY_CAP = 200

// ── Store ─────────────────────────────────────────────────────────────────────

interface AutoState {
  // 环境
  detect: OsDetect | null
  detecting: boolean
  installing: boolean
  installLog: string[]

  // 运行配置
  workspace: string
  topic: string
  providerId: string | null
  model: string | null

  // 运行
  runId: string | null
  runStatus: 'idle' | RunStatus
  runStartedAt: number | null
  runEndedAt: number | null
  runExit: number | null
  starting: boolean

  // 日志与阶段
  log: LogLine[]
  phases: PhaseMap
  activePhase: PhaseId | null
  phaseFilter: PhaseId | null

  // 产物
  artifacts: OsArtifact[]
  artifactsAt: number | null

  // 历史台账
  history: AutoRunRecord[]

  // 检查器 / 历史区 UI（持久化）
  inspectorOpen: boolean
  inspectorWidth: number
  inspectorMaximized: boolean
  historyOpen: boolean

  error: string | null

  // actions
  init: () => Promise<void>
  detectEnv: () => Promise<void>
  install: () => Promise<void>
  setWorkspace: (dir: string) => void
  pickWorkspace: () => Promise<void>
  setTopic: (t: string) => void
  setModel: (providerId: string, model: string) => void
  start: () => Promise<void>
  stop: () => Promise<void>
  clearLog: () => void
  setPhaseFilter: (p: PhaseId | null) => void
  refreshArtifacts: () => Promise<void>
  reproduce: (rec: AutoRunRecord) => void
  deleteHistory: (id: string) => void
  setInspectorOpen: (open: boolean) => void
  setInspectorWidth: (w: number) => void
  setInspectorMaximized: (v: boolean) => void
  setHistoryOpen: (open: boolean) => void
  clearError: () => void

  _onOsEvent: (p: OsEventPayload) => void
  _appendLine: (line: string, stderr: boolean) => void
  _finalizeRun: (code: number, stopped: boolean, stderrTail: string | null) => void
}

export const useAutoStore = create<AutoState>()((set, get) => {
  // ── 内部：持久化快照 ──
  const persistConfig = () => {
    const s = get()
    const snap: ConfigPersist = {
      workspace: s.workspace,
      topic: s.topic,
      providerId: s.providerId,
      model: s.model,
    }
    saveJson(CONFIG_KEY, snap)
  }
  const persistHistory = () => saveJson(HISTORY_KEY, get().history.slice(0, HISTORY_CAP))
  const persistUi = () => {
    const s = get()
    const snap: UiPersist = {
      inspectorOpen: s.inspectorOpen,
      inspectorWidth: s.inspectorWidth,
      historyOpen: s.historyOpen,
    }
    saveJson(UI_KEY, snap)
  }

  const stopPoll = () => {
    if (pollTimer != null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
  const startPoll = () => {
    stopPoll()
    pollTimer = setInterval(() => {
      void get().refreshArtifacts()
    }, ARTIFACT_POLL_MS)
  }

  return {
    detect: null,
    detecting: false,
    installing: false,
    installLog: [],

    workspace: '',
    topic: '',
    providerId: null,
    model: null,

    runId: null,
    runStatus: 'idle',
    runStartedAt: null,
    runEndedAt: null,
    runExit: null,
    starting: false,

    log: [],
    phases: freshPhases(),
    activePhase: null,
    phaseFilter: null,

    artifacts: [],
    artifactsAt: null,

    history: [],

    inspectorOpen: true,
    inspectorWidth: 360,
    inspectorMaximized: false,
    historyOpen: true,

    error: null,

    init: async () => {
      if (initialized) return
      initialized = true

      const cfg = loadJson<ConfigPersist>(CONFIG_KEY)
      const ui = loadJson<UiPersist>(UI_KEY)
      const hist = loadJson<AutoRunRecord[]>(HISTORY_KEY) ?? []
      // 应用重启后仍标记 running 的记录已成孤儿 → 视为中断。
      const history = hist.map((r) =>
        r.status === 'running' ? { ...r, status: 'stopped' as const, endedAt: r.endedAt ?? r.startedAt } : r,
      )
      set({
        workspace: cfg?.workspace ?? '',
        topic: cfg?.topic ?? '',
        providerId: cfg?.providerId ?? null,
        model: cfg?.model ?? null,
        inspectorOpen: ui?.inspectorOpen ?? true,
        inspectorWidth: ui?.inspectorWidth ?? 360,
        historyOpen: ui?.historyOpen ?? true,
        history,
      })

      // os-event 监听器：app 生命周期内注册一次，不随组件卸载。
      if (isTauri && !listenerRegistered) {
        listenerRegistered = true
        try {
          const { listen } = await import('@tauri-apps/api/event')
          await listen<OsEventPayload>('os-event', (e) => {
            get()._onOsEvent(e.payload)
          })
        } catch {
          listenerRegistered = false
        }
      }

      void get().detectEnv()
      if (get().workspace) void get().refreshArtifacts()
    },

    detectEnv: async () => {
      if (!isTauri) return
      set({ detecting: true })
      try {
        set({ detect: await tauriInvoke<OsDetect>('os_detect') })
      } catch (e) {
        set({ error: `环境检测失败：${String(e)}` })
      } finally {
        set({ detecting: false })
      }
    },

    install: async () => {
      if (!isTauri || get().installing) return
      set({ installing: true, installLog: [], error: null })
      try {
        await tauriInvoke('os_install')
      } catch (e) {
        set({ installing: false, error: `安装启动失败：${String(e)}` })
      }
    },

    setWorkspace: (dir) => {
      set({ workspace: dir })
      persistConfig()
      if (dir.trim()) void get().refreshArtifacts()
    },

    pickWorkspace: async () => {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const dir = await open({ directory: true, multiple: false, title: '选择研究工作目录' })
        if (typeof dir === 'string' && dir) get().setWorkspace(dir)
      } catch (e) {
        set({ error: `选择目录失败：${String(e)}` })
      }
    },

    setTopic: (t) => {
      set({ topic: t })
      persistConfig()
    },

    setModel: (providerId, model) => {
      set({ providerId, model })
      persistConfig()
    },

    start: async () => {
      const s = get()
      if (s.runStatus === 'running' || s.starting || !isTauri) return
      const workspace = s.workspace.trim()
      const topic = s.topic.trim()
      if (!workspace) return set({ error: '请先选择工作目录' })
      if (!topic) return set({ error: '请填写研究方向' })
      if (!s.model) return set({ error: '请先选择模型（设置里配置服务商后自动加载）' })

      set({
        starting: true,
        error: null,
        log: [],
        phases: freshPhases(),
        activePhase: null,
        phaseFilter: null,
        runExit: null,
        runEndedAt: null,
      })
      awaitingRun = true
      pendingLines = []
      pendingDone = null

      try {
        // 每次开跑前都重写 openscience.json（幂等、保证模型/provider 一致）。
        await tauriInvoke<string>('os_prepare', {
          workspace,
          providerId: s.providerId,
          model: s.model,
        })
        const runId = await tauriInvoke<string>('os_run', {
          workspace,
          topic,
          providerId: s.providerId,
          model: s.model,
        })
        const now = Date.now()
        const rec: AutoRunRecord = {
          id: runId,
          topic,
          workspace,
          providerId: s.providerId ?? '',
          model: s.model,
          startedAt: now,
          endedAt: null,
          status: 'running',
          artifactCount: 0,
          logTail: [],
        }
        // 起跑即把 explore 置为进行中（primary agent 的第一站）。
        const phases = freshPhases()
        phases.explore = { status: 'active', startedAt: now, endedAt: null }
        set((st) => ({
          runId,
          runStatus: 'running',
          runStartedAt: now,
          starting: false,
          phases,
          activePhase: 'explore',
          history: [rec, ...st.history].slice(0, HISTORY_CAP),
        }))
        persistHistory()

        useTaskRegistry.getState().registerTask({
          id: runId,
          module: 'auto',
          title: `自动科研：${topic.slice(0, 24)}${topic.length > 24 ? '…' : ''}`,
          detail: '阶段：探索',
        })

        // flush invoke 返回前抢跑的事件。
        awaitingRun = false
        const buffered = pendingLines
        pendingLines = []
        for (const b of buffered) get()._appendLine(b.line, b.stderr)
        const done = takePendingDone()
        if (done) {
          get()._finalizeRun(done.code, done.stopped, done.stderrTail)
          return
        }

        startPoll()
        void get().refreshArtifacts()
      } catch (e) {
        awaitingRun = false
        set({ starting: false, error: String(e) })
      }
    },

    stop: async () => {
      const runId = get().runId
      if (!runId || !isTauri) return
      try {
        await tauriInvoke('os_stop', { runId })
      } catch (e) {
        set({ error: `停止失败：${String(e)}` })
      }
    },

    clearLog: () => set({ log: [] }),

    setPhaseFilter: (p) => set({ phaseFilter: p }),

    refreshArtifacts: async () => {
      const workspace = get().workspace.trim()
      if (!workspace || !isTauri) return
      try {
        const artifacts = await tauriInvoke<OsArtifact[]>('os_artifacts', { workspace })
        set({ artifacts, artifactsAt: Date.now() })
      } catch {
        /* 目录未建/暂不可读时静默 */
      }
    },

    reproduce: (rec) => {
      set({
        workspace: rec.workspace,
        topic: rec.topic,
        providerId: rec.providerId || null,
        model: rec.model || null,
        error: null,
      })
      persistConfig()
      void get().refreshArtifacts()
    },

    deleteHistory: (id) => {
      set((s) => ({ history: s.history.filter((r) => r.id !== id) }))
      persistHistory()
    },

    setInspectorOpen: (open) => {
      set({ inspectorOpen: open, inspectorMaximized: open ? get().inspectorMaximized : false })
      persistUi()
    },

    setInspectorWidth: (w) => {
      set({ inspectorWidth: w })
      persistUi()
    },

    setInspectorMaximized: (v) => set({ inspectorMaximized: v }),

    setHistoryOpen: (open) => {
      set({ historyOpen: open })
      persistUi()
    },

    clearError: () => set({ error: null }),

    // ── 事件处理 ──────────────────────────────────────────────────────────────

    _onOsEvent: (p) => {
      if (p.kind === 'install_output') {
        if (p.line == null) return
        const line = p.line
        set((s) => ({ installLog: [...s.installLog.slice(-400), line] }))
        return
      }
      if (p.kind === 'install_done') {
        set((s) => ({
          installing: false,
          installLog: [...s.installLog, `安装进程退出（code=${p.code}）`],
        }))
        void get().detectEnv()
        return
      }
      if (p.kind === 'run_output' || p.kind === 'run_stderr') {
        if (p.line == null) return
        const stderr = p.kind === 'run_stderr'
        if (awaitingRun && !get().runId) {
          pendingLines.push({ line: p.line, stderr })
          return
        }
        if (p.runId !== get().runId) return
        get()._appendLine(p.line, stderr)
        return
      }
      if (p.kind === 'run_done') {
        const done = {
          code: p.code ?? -1,
          stopped: !!p.stopped,
          stderrTail: p.stderr_tail ?? null,
        }
        if (awaitingRun && !get().runId) {
          pendingDone = done
          return
        }
        if (p.runId !== get().runId) return
        get()._finalizeRun(done.code, done.stopped, done.stderrTail)
      }
    },

    _appendLine: (line, stderr) => {
      const now = Date.now()
      set((s) => {
        let phases = s.phases
        let active = s.activePhase
        let phaseAdvanced: PhaseId | null = null
        for (const ph of PHASES) {
          if (phases[ph.id].status === 'pending' && lineHitsPhase(line, ph.id)) {
            if (phases === s.phases) phases = { ...phases }
            if (active && phases[active].status === 'active') {
              phases[active] = { ...phases[active], status: 'done', endedAt: now }
            }
            phases[ph.id] = { status: 'active', startedAt: now, endedAt: null }
            active = ph.id
            phaseAdvanced = ph.id
          }
        }
        if (phaseAdvanced && s.runId) {
          const label = PHASES.find((x) => x.id === phaseAdvanced)?.label ?? phaseAdvanced
          useTaskRegistry.getState().updateTask(s.runId, { detail: `阶段：${label}` })
        }
        const entry: LogLine = {
          id: ++lineSeq,
          raw: line,
          text: prettyLine(line),
          phase: active,
          stderr,
          ts: now,
        }
        let log = [...s.log, entry]
        if (log.length > LOG_CAP) log = log.slice(log.length - LOG_TRIM_TO)
        return { log, phases, activePhase: active }
      })
    },

    _finalizeRun: (code, stopped, stderrTail) => {
      stopPoll()
      const now = Date.now()
      const status: RunStatus = stopped ? 'stopped' : code === 0 ? 'done' : 'error'
      set((s) => {
        const phases = { ...s.phases }
        for (const ph of PHASES) {
          const st = phases[ph.id]
          if (st.status !== 'active') continue
          phases[ph.id] = {
            ...st,
            status: status === 'done' ? 'done' : status === 'error' ? 'error' : 'done',
            endedAt: now,
          }
        }
        const endText = stopped
          ? '—— 已手动停止 ——'
          : `—— 运行结束（code=${code}）——` +
            (code !== 0 && stderrTail ? '\n' + stderrTail : '')
        const entry: LogLine = {
          id: ++lineSeq,
          raw: endText,
          text: endText,
          phase: s.activePhase,
          stderr: !stopped && code !== 0,
          ts: now,
        }
        const log = [...s.log, entry]
        const history = s.history.map((r) =>
          r.id === s.runId
            ? {
                ...r,
                endedAt: now,
                status,
                logTail: log.slice(-HISTORY_TAIL_LINES).map((l) => l.text),
              }
            : r,
        )
        if (s.runId) {
          useTaskRegistry.getState().updateTask(s.runId, {
            status: status === 'error' ? 'error' : 'done',
            detail: stopped ? '已手动停止' : status === 'done' ? '流水线完成' : `退出 code=${code}`,
          })
        }
        return {
          runId: null,
          runStatus: status,
          runEndedAt: now,
          runExit: code,
          log,
          phases,
          history,
        }
      })
      persistHistory()
      // 收尾再刷一次产物，并把产物数写回台账。
      void get()
        .refreshArtifacts()
        .then(() => {
          set((s) => {
            const latest = s.history[0]
            if (!latest || latest.endedAt !== now) return {}
            return {
              history: s.history.map((r, i) =>
                i === 0 ? { ...r, artifactCount: s.artifacts.length } : r,
              ),
            }
          })
          persistHistory()
        })
    },
  }
})
