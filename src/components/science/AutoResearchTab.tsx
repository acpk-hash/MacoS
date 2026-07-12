/**
 * AutoResearchTab -- 自动科研（open-science / @synsci/openscience 集成，A 档）
 *
 * 实证结论（openscience 1.3.4，见 src-tauri/src/openscience.rs 头注释）：
 * - headless CLI 真实存在：`openscience run --agent research -m provider/model
 *   --format json "<topic>"`，stdout 逐行 JSON 事件。
 * - 工作目录配置文件必须叫 openscience.json（opencode.json 不被读取）；
 *   apiKey 用 {env:OPENAI_API_KEY} 引用，明文 key 不落盘（run 时后端注入）。
 * - research(primary) 编排 explore / literature-review / critique / write 等
 *   subagent —— 即「探索→文献综述→实验评审→论文撰写」流水线。
 *
 * 状态流：检测(os_detect) → 一键安装(os_install 流式) → 配置（工作目录 +
 * 模型 + 研究方向）→ 准备配置(os_prepare) → 开始研究(os_run 流式日志 +
 * 阶段徽章) → 产物列表(os_artifacts 轮询/手动刷新；md 预览，pdf 展示路径+复制)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import MarkdownLite from '../ui/MarkdownLite'
import { useWorkbenchStore } from '../../stores/workbenchStore'

const NL = String.fromCharCode(10)

const CARD =
  'bg-surface border border-line rounded-card shadow-card transition-all duration-150'
const BTN_PRIMARY =
  'px-3 py-1.5 text-[12.5px] rounded-lg bg-primary-tint text-primary font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity'
const BTN_GHOST =
  'px-3 py-1.5 text-[12.5px] rounded-lg border border-line text-ink-dim hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
const INPUT =
  'w-full bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-primary/50'

// ── 后端契约类型 ──────────────────────────────────────────────────────────────

interface OsDetect {
  installed: boolean
  version: string | null
  node: boolean
}

interface OsArtifact {
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

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── 流水线阶段徽章（按 run 事件流里出现的 subagent 名点亮）────────────────────

const PHASES = [
  { id: 'explore', label: '探索' },
  { id: 'literature-review', label: '文献综述' },
  { id: 'critique', label: '实验与评审' },
  { id: 'write', label: '论文撰写' },
] as const

/** 把一行 JSON 事件转成可读日志；解析失败原样截断返回。 */
function prettyLine(raw: string): string {
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
    /* 非 JSON（banner/警告等）原样展示 */
  }
  return raw.length > 400 ? raw.slice(0, 400) + '…' : raw
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function fmtTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—'
}

const KIND_TONE: Record<string, string> = {
  pdf: 'bg-primary-tint text-primary',
  md: 'bg-surface-2 text-mint',
  tex: 'bg-surface-2 text-sky',
  jsonl: 'bg-surface-2 text-ink-muted',
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

export default function AutoResearchTab() {
  // 检测/安装
  const [detect, setDetect] = useState<OsDetect | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])

  // 配置
  const [workspace, setWorkspace] = useState('')
  const [topic, setTopic] = useState('')
  const [preparedPath, setPreparedPath] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)

  // 运行
  const [runId, setRunId] = useState<string | null>(null)
  const [runLog, setRunLog] = useState<string[]>([])
  const [phasesSeen, setPhasesSeen] = useState<Set<string>>(new Set())
  const [runExit, setRunExit] = useState<number | null>(null)

  // 产物
  const [artifacts, setArtifacts] = useState<OsArtifact[]>([])
  const [preview, setPreview] = useState<{ name: string; kind: string; text: string } | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  const [error, setError] = useState<string | null>(null)

  // 模型：只读 workbenchStore 聚合（chat 模型），默认 gpt-5.5
  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)
  const [modelSel, setModelSel] = useState<{ providerId: string; modelId: string } | null>(null)

  const runIdRef = useRef<string | null>(null)
  runIdRef.current = runId
  const logRef = useRef<HTMLDivElement | null>(null)

  // ── 初始化：检测 + 模型加载 + os-event 订阅 ────────────────────────────────
  const doDetect = useCallback(async () => {
    setDetecting(true)
    try {
      setDetect(await tauriInvoke<OsDetect>('os_detect'))
    } catch (e) {
      setError(`检测失败：${String(e)}`)
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void doDetect()
    if (!useWorkbenchStore.getState().modelsLoaded) {
      void useWorkbenchStore.getState().loadModels()
    }
  }, [doDetect])

  // 默认模型 gpt-5.5（load 完成后仅设一次）
  useEffect(() => {
    if (!modelsLoaded || modelSel || aggModels.length === 0) return
    const first = aggModels.find((m) => m.modelId === 'gpt-5.5') ?? aggModels[0]
    setModelSel({ providerId: first.providerId, modelId: first.modelId })
  }, [modelsLoaded, aggModels, modelSel])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const un = await listen<OsEventPayload>('os-event', (e) => {
          const p = e.payload
          if (p.kind === 'install_output' && p.line != null) {
            setInstallLog((l) => [...l.slice(-300), p.line as string])
          } else if (p.kind === 'install_done') {
            setInstalling(false)
            setInstallLog((l) => [...l, `安装进程退出（code=${p.code}）`])
            void doDetect()
          } else if (p.kind === 'run_output' || p.kind === 'run_stderr') {
            if (p.runId !== runIdRef.current || p.line == null) return
            const line = p.line
            setRunLog((l) => [...l.slice(-500), prettyLine(line)])
            setPhasesSeen((prev) => {
              const hit = PHASES.filter((ph) => line.includes(ph.id) && !prev.has(ph.id))
              if (hit.length === 0) return prev
              const next = new Set(prev)
              hit.forEach((ph) => next.add(ph.id))
              return next
            })
          } else if (p.kind === 'run_done') {
            if (p.runId !== runIdRef.current) return
            setRunId(null)
            setRunExit(p.code ?? -1)
            setRunLog((l) => [
              ...l,
              p.stopped
                ? '—— 已手动停止 ——'
                : `—— 运行结束（code=${p.code}）——` +
                  (p.code !== 0 && p.stderr_tail ? NL + p.stderr_tail : ''),
            ])
          }
        })
        if (disposed) un()
        else unlisten = un
      } catch {
        /* 非 Tauri 环境（纯浏览器 dev）忽略 */
      }
    })()
    return () => {
      disposed = true
      if (unlisten) unlisten()
    }
  }, [doDetect])

  // 日志自动滚底
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [runLog, installLog])

  // 运行期间轮询产物（8s），结束后再刷一次
  const refreshArtifacts = useCallback(async () => {
    if (!workspace.trim()) return
    try {
      setArtifacts(await tauriInvoke<OsArtifact[]>('os_artifacts', { workspace }))
    } catch {
      /* 目录未建时静默 */
    }
  }, [workspace])

  useEffect(() => {
    if (!runId) return
    const t = setInterval(() => void refreshArtifacts(), 8000)
    return () => clearInterval(t)
  }, [runId, refreshArtifacts])

  useEffect(() => {
    if (runExit != null) void refreshArtifacts()
  }, [runExit, refreshArtifacts])

  // ── 操作 ───────────────────────────────────────────────────────────────────

  const pickWorkspace = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const dir = await open({ directory: true, multiple: false, title: '选择研究工作目录' })
      if (typeof dir === 'string' && dir) {
        setWorkspace(dir)
        setPreparedPath(null)
      }
    } catch (e) {
      setError(`选择目录失败：${String(e)}`)
    }
  }

  const install = async () => {
    setError(null)
    setInstallLog([])
    setInstalling(true)
    try {
      await tauriInvoke('os_install')
    } catch (e) {
      setInstalling(false)
      setError(`安装启动失败：${String(e)}`)
    }
  }

  const prepare = async () => {
    if (!workspace.trim() || !modelSel) return
    setError(null)
    setPreparing(true)
    try {
      const path = await tauriInvoke<string>('os_prepare', {
        workspace,
        providerId: modelSel.providerId,
        model: modelSel.modelId,
      })
      setPreparedPath(path)
      void refreshArtifacts()
    } catch (e) {
      setError(String(e))
    } finally {
      setPreparing(false)
    }
  }

  const start = async () => {
    if (!workspace.trim() || !topic.trim() || !modelSel) return
    setError(null)
    setRunLog([])
    setPhasesSeen(new Set())
    setRunExit(null)
    try {
      const id = await tauriInvoke<string>('os_run', {
        workspace,
        topic,
        providerId: modelSel.providerId,
        model: modelSel.modelId,
      })
      setRunId(id)
    } catch (e) {
      setError(String(e))
    }
  }

  const stop = async () => {
    if (!runId) return
    try {
      await tauriInvoke('os_stop', { runId })
    } catch (e) {
      setError(String(e))
    }
  }

  const openPreview = async (a: OsArtifact) => {
    try {
      const text = await tauriInvoke<string>('os_read_text', { path: a.path })
      setPreview({ name: a.name, kind: a.kind, text })
    } catch (e) {
      setError(String(e))
    }
  }

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(path)
      setTimeout(() => setCopiedPath((p) => (p === path ? null : p)), 1500)
    } catch {
      setError('复制失败，请手动复制路径')
    }
  }

  const ready = !!detect?.installed
  const canRun = ready && !!workspace.trim() && !!topic.trim() && !!modelSel && !runId

  // ── 渲染 ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-[860px] mx-auto space-y-3">
        {/* 档位说明 */}
        <div className="text-[11.5px] text-ink-muted leading-5">
          集成 open-science（@synsci/openscience，MIT）自动科研流水线 · 完整档（headless
          CLI）：openscience run --agent research 在本地工作目录跑
          探索→文献综述→实验评审→论文撰写，产物（PDF/LaTeX/Markdown/provenance）落在工作目录内。API
          Key 从系统凭据库注入运行环境，不写入任何文件。
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg border border-rose-500/30 bg-rose-500/10 text-[12px] text-rose-300 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* 1. 环境检测 / 安装 */}
        <section className={CARD + ' p-3'}>
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">环境</h3>
            <span className="text-[11.5px] text-ink-muted">
              {detecting
                ? '检测中…'
                : detect
                  ? `Node ${detect.node ? '✓' : '✗ 未安装'} · openscience ${
                      detect.installed ? `✓ ${detect.version ?? ''}` : '✗ 未安装'
                    }`
                  : '未检测'}
            </span>
            <div className="flex-1" />
            <button className={BTN_GHOST} onClick={() => void doDetect()} disabled={detecting}>
              重新检测
            </button>
            {!ready && (
              <button
                className={BTN_PRIMARY}
                onClick={() => void install()}
                disabled={installing || !detect?.node}
                title={detect?.node ? '' : '需要先安装 Node.js'}
              >
                {installing ? '安装中…' : '一键安装'}
              </button>
            )}
          </div>
          {installLog.length > 0 && (
            <pre className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-surface-2 border border-line p-2 text-[11px] text-ink-dim whitespace-pre-wrap">
              {installLog.join(NL)}
            </pre>
          )}
        </section>

        {/* 2. 研究配置 */}
        <section className={CARD + ' p-3 space-y-2.5'}>
          <h3 className="text-[13px] font-semibold text-ink">研究配置</h3>
          <div className="flex items-center gap-2">
            <input
              className={INPUT}
              placeholder="研究工作目录（产物与 openscience.json 落在这里）"
              value={workspace}
              onChange={(e) => {
                setWorkspace(e.target.value)
                setPreparedPath(null)
              }}
            />
            <button className={BTN_GHOST + ' shrink-0'} onClick={() => void pickWorkspace()}>
              选择目录
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink-dim shrink-0">模型</span>
            <select
              className={INPUT + ' max-w-[320px]'}
              value={modelSel ? `${modelSel.providerId}::${modelSel.modelId}` : ''}
              onChange={(e) => {
                const [providerId, modelId] = e.target.value.split('::')
                if (providerId && modelId) setModelSel({ providerId, modelId })
                setPreparedPath(null)
              }}
            >
              {!modelsLoaded && <option value="">加载中…</option>}
              {modelsLoaded && aggModels.length === 0 && (
                <option value="">无可用模型（请先在设置里配置服务商）</option>
              )}
              {aggModels.map((m) => (
                <option
                  key={`${m.providerId}::${m.modelId}`}
                  value={`${m.providerId}::${m.modelId}`}
                >
                  {m.providerLabel} / {m.modelId}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className={INPUT + ' min-h-[72px] resize-y'}
            placeholder="研究方向 / 课题描述（将作为 research agent 的初始指令）"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              className={BTN_GHOST}
              onClick={() => void prepare()}
              disabled={!ready || preparing || !workspace.trim() || !modelSel}
            >
              {preparing ? '准备中…' : '准备配置（生成 openscience.json）'}
            </button>
            {preparedPath && modelSel && (
              <span className="text-[11.5px] text-ink-muted truncate">
                已写入 {preparedPath} · provider=agentboard · model={modelSel.modelId} · key=
                {'{env:OPENAI_API_KEY}'} 引用（明文不落盘）
              </span>
            )}
          </div>
        </section>

        {/* 3. 运行 */}
        <section className={CARD + ' p-3 space-y-2.5'}>
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">自动科研流水线</h3>
            <div className="flex items-center gap-1.5">
              {PHASES.map((ph) => (
                <span
                  key={ph.id}
                  className={
                    'px-2 py-0.5 rounded-full text-[11px] ' +
                    (phasesSeen.has(ph.id)
                      ? 'bg-primary-tint text-primary font-medium'
                      : 'bg-surface-2 text-ink-muted')
                  }
                >
                  {ph.label}
                </span>
              ))}
            </div>
            <div className="flex-1" />
            {runId ? (
              <button className={BTN_GHOST} onClick={() => void stop()}>
                停止
              </button>
            ) : (
              <button
                className={BTN_PRIMARY}
                onClick={() => void start()}
                disabled={!canRun}
                title={preparedPath ? '' : '未准备配置时将要求工作目录已有 openscience.json'}
              >
                开始研究
              </button>
            )}
          </div>
          {runId && (
            <div className="text-[11.5px] text-ink-muted">
              运行中… run={runId.slice(0, 8)} · 阶段徽章按事件流自动点亮 · 产物每 8 秒自动刷新
            </div>
          )}
          {(runLog.length > 0 || runId) && (
            <div
              ref={logRef}
              className="max-h-64 overflow-y-auto rounded-lg bg-surface-2 border border-line p-2 text-[11.5px] text-ink-dim whitespace-pre-wrap leading-5"
            >
              {runLog.length === 0 ? '等待输出…' : runLog.join(NL)}
            </div>
          )}
        </section>

        {/* 4. 产物 */}
        <section className={CARD + ' p-3 space-y-2'}>
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">产物</h3>
            <span className="text-[11.5px] text-ink-muted">
              {artifacts.length > 0
                ? `${artifacts.length} 个文件`
                : '暂无（PDF/Markdown/LaTeX/provenance）'}
            </span>
            <div className="flex-1" />
            <button
              className={BTN_GHOST}
              onClick={() => void refreshArtifacts()}
              disabled={!workspace.trim()}
            >
              刷新
            </button>
          </div>
          {artifacts.length > 0 && (
            <ul className="divide-y divide-line">
              {artifacts.map((a) => (
                <li key={a.path} className="py-1.5 flex items-center gap-2">
                  <span
                    className={
                      'px-1.5 py-0.5 rounded text-[10.5px] font-mono uppercase ' +
                      (KIND_TONE[a.kind] ?? 'bg-surface-2 text-ink-muted')
                    }
                  >
                    {a.kind}
                  </span>
                  <span className="text-[12.5px] text-ink truncate" title={a.path}>
                    {a.name}
                  </span>
                  <span className="text-[11px] text-ink-muted shrink-0">
                    {fmtSize(a.size)} · {fmtTime(a.mtime)}
                  </span>
                  <div className="flex-1" />
                  {a.kind !== 'pdf' && (
                    <button className={BTN_GHOST + ' !py-0.5'} onClick={() => void openPreview(a)}>
                      预览
                    </button>
                  )}
                  <button className={BTN_GHOST + ' !py-0.5'} onClick={() => void copyPath(a.path)}>
                    {copiedPath === a.path ? '已复制' : '复制路径'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="text-[11px] text-ink-muted">
            PDF 请复制路径后用系统查看器打开（应用内暂不内置本地文件打开命令）。
          </div>
        </section>
      </div>

      {/* 文本产物预览 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8"
          onClick={() => setPreview(null)}
        >
          <div
            className={CARD + ' w-full max-w-[760px] max-h-[80vh] flex flex-col p-4'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center mb-2">
              <h4 className="text-[13px] font-semibold text-ink truncate">{preview.name}</h4>
              <div className="flex-1" />
              <button className={BTN_GHOST} onClick={() => setPreview(null)}>
                关闭
              </button>
            </div>
            <div className="overflow-y-auto">
              {preview.kind === 'md' ? (
                <MarkdownLite text={preview.text} />
              ) : (
                <pre className="text-[11.5px] text-ink-dim whitespace-pre-wrap leading-5">
                  {preview.text}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
