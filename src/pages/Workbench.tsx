// 统一工作区（G2b）— Trae/Cursor 式三栏 IDE：文件树 + Monaco 编辑器 + AI 对话。
// 复用 workbenchStore 的 pi 引擎接线，文件系统/编辑器状态在 workspaceStore。
// G2c：底部面板接入 SSH 远程，顶栏新增「扩展」入口（MCP 工具 + 技能）。
import { useEffect, useRef, useState } from 'react'
import { useWorkbenchStore, type WorkbenchStats } from '../stores/workbenchStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { useSshStore } from '../stores/sshStore'
import ModelPicker from '../components/ModelPicker'
import Mascot from '../components/ui/Mascot'
import FileTree from '../components/workbench/FileTree'
import EditorPane from '../components/workbench/EditorPane'
import ChatPanel from '../components/workbench/ChatPanel'
import BottomPanel, { type BottomTab } from '../components/workbench/BottomPanel'
import ExtensionsPanel from '../components/workbench/ExtensionsPanel'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function contextPct(t: WorkbenchStats): number {
  if (t.context_window > 0) return Math.min(100, (t.context_tokens / t.context_window) * 100)
  return t.context_percent > 1 ? t.context_percent : t.context_percent * 100
}

function TokenBadge({ tokens }: { tokens: WorkbenchStats }) {
  const [hover, setHover] = useState(false)
  const pct = contextPct(tokens)
  const tone = pct > 85 ? 'text-coral' : pct > 60 ? 'text-gold' : 'text-mint'
  return (
    <div
      className="relative flex-shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-btn bg-white/5 border border-line text-[11px] text-ink-muted font-mono cursor-default">
        <span className="text-lavender">Σ</span>
        <span>{fmt(tokens.total)}</span>
        <span className={tone}>{pct.toFixed(0)}%</span>
      </div>
      {hover && (
        <div className="absolute right-0 top-9 z-40 w-52 p-3 rounded-card glass-strong text-[11px] text-ink-muted font-mono">
          <Row k="上下文" v={`${pct.toFixed(1)}%`} />
          <Row k="输入" v={fmt(tokens.input)} />
          <Row k="输出" v={fmt(tokens.output)} />
          <Row k="缓存读" v={fmt(tokens.cache_read)} />
          <Row k="缓存写" v={fmt(tokens.cache_write)} />
          <Row k="合计" v={fmt(tokens.total)} />
          {tokens.cost > 0 && <Row k="费用" v={`$${tokens.cost.toFixed(4)}`} />}
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-ink-dim">{k}</span>
      <span className="text-ink">{v}</span>
    </div>
  )
}

export default function Workbench() {
  const {
    aggModels,
    currentModel,
    currentProviderId,
    modelsLoaded,
    sessionId,
    opening: piOpening,
    tokens,
    error: wbError,
    notice: wbNotice,
    loadModels,
    setModelSel,
    switchModel,
    exportHtml,
    close: piClose,
    consumeReuse,
    clearNotice: wbClear,
  } = useWorkbenchStore()

  const wbFiles = useWorkbenchStore((s) => s.files)

  const root = useWorkspaceStore((s) => s.root)
  const name = useWorkspaceStore((s) => s.name)
  const recent = useWorkspaceStore((s) => s.recent)
  const wsOpening = useWorkspaceStore((s) => s.opening)
  const wsError = useWorkspaceStore((s) => s.error)
  const wsNotice = useWorkspaceStore((s) => s.notice)
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const loadRecent = useWorkspaceStore((s) => s.loadRecent)
  const applyAiTouched = useWorkspaceStore((s) => s.applyAiTouched)
  const wsReset = useWorkspaceStore((s) => s.reset)
  const wsClear = useWorkspaceStore((s) => s.clearNotice)

  const [draft, setDraft] = useState('')
  const [bottomOpen, setBottomOpen] = useState(false)
  const [bottomTab, setBottomTab] = useState<BottomTab>('tasks')
  const [extOpen, setExtOpen] = useState(false)
  const prevSig = useRef<Map<string, string>>(new Map())

  // 打开一个目录：同时接文件系统（树/编辑器）与 pi 引擎（AI 在该目录工作）。
  const openDir = async (path: string) => {
    await openFolder(path)
    await useWorkbenchStore.getState().open(path)
  }

  const pickDir = async () => {
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ directory: true, multiple: false })
      if (typeof picked === 'string') await openDir(picked)
    } catch (e) {
      useWorkspaceStore.setState({ error: `选择文件夹失败：${String(e)}` })
    }
  }

  const closeAll = async () => {
    await piClose()
    wsReset()
  }

  useEffect(() => {
    if (!isTauri) return
    loadModels()
    void loadRecent()
    void useSshStore.getState().loadSaved()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 复用（从沉淀页交接）：打开记录的目录 + 预填首个 prompt（不自动发送）。
  useEffect(() => {
    if (!isTauri || !modelsLoaded) return
    const req = useWorkbenchStore.getState().reuseRequest
    if (!req) return
    const cwd = req.cwd
    void (async () => {
      const prompt = await consumeReuse()
      await openFolder(cwd)
      if (prompt != null) setDraft(prompt)
    })()
  }, [modelsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // AI 改动的文件 → 同步到编辑器/文件树（仅处理新变化的路径）。
  useEffect(() => {
    const changed: string[] = []
    const next = new Map<string, string>()
    for (const f of wbFiles) {
      next.set(f.path, f.entryId)
      if (prevSig.current.get(f.path) !== f.entryId) changed.push(f.path)
    }
    prevSig.current = next
    if (changed.length) void applyAiTouched(changed)
  }, [wbFiles]) // eslint-disable-line react-hooks/exhaustive-deps

  // Toast 自动消失（合并两个 store 的提示）。
  const toast = wbError ?? wsError ?? wbNotice ?? wsNotice
  const isErr = !!(wbError ?? wsError)
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => {
      wbClear()
      wsClear()
    }, 3600)
    return () => window.clearTimeout(t)
  }, [toast]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Mascot mood="sad" size={80} />
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
        <p className="text-ink-dim text-xs">统一工作区需要 Tauri 桌面运行时。</p>
      </div>
    )
  }

  const noProviders = modelsLoaded && aggModels.length === 0

  return (
    <div className="flex flex-col h-full text-ink">
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 h-12 border-b border-line glass flex-shrink-0">
        <button
          onClick={() => void pickDir()}
          disabled={wsOpening}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-btn bg-white/5 hover:bg-white/10 border border-line hover:border-line-strong text-[12px] text-ink transition-colors disabled:opacity-40 max-w-[240px]"
          title={root ?? '选择工作目录'}
        >
          <span aria-hidden="true">📁</span>
          <span className="truncate">{name ?? '打开文件夹'}</span>
        </button>

        {recent.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) void openDir(e.target.value)
            }}
            title="最近打开"
            className="flex-shrink-0 bg-white/5 border border-line rounded-btn px-2 py-1.5 text-[11px] text-ink-muted focus:outline-none focus:border-line-strong max-w-[160px]"
          >
            <option value="">最近…</option>
            {recent.map((p) => (
              <option key={p} value={p}>
                {baseName(p)}
              </option>
            ))}
          </select>
        )}

        {root && (
          <span className="text-[11px] text-ink-dim font-mono truncate max-w-[280px] hidden xl:block" title={root}>
            {root}
          </span>
        )}

        <div className="flex-1" />

        {(piOpening || wsOpening) && (
          <span className="text-[11px] text-lavender animate-pulse flex-shrink-0">加载中…</span>
        )}

        <button
          onClick={() => setExtOpen(true)}
          className="flex-shrink-0 flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink border border-line rounded-btn px-2 py-1.5 transition-colors"
          title="扩展中心：MCP 工具 + 技能"
        >
          <span aria-hidden="true">🧩</span>
          <span className="hidden sm:inline">扩展</span>
        </button>

        <ModelPicker
          models={aggModels}
          value={{ providerId: currentProviderId ?? '', modelId: currentModel }}
          onChange={(v) => {
            if (sessionId) void switchModel(v.providerId, v.modelId)
            else setModelSel(v.providerId, v.modelId)
          }}
          className="flex-shrink-0 bg-white/5 border border-line rounded-btn px-2 py-1.5 text-[11px] text-ink focus:outline-none focus:border-line-strong max-w-[180px]"
          title="选择模型（切换会新开会话）"
        />

        <TokenBadge tokens={tokens} />

        {sessionId && (
          <>
            <button
              onClick={() => void exportHtml()}
              className="flex-shrink-0 text-[11px] text-ink-muted hover:text-ink border border-line rounded-btn px-2 py-1.5 transition-colors"
              title="导出会话为 HTML"
            >
              导出
            </button>
            <button
              onClick={() => void closeAll()}
              className="flex-shrink-0 text-[11px] text-ink-dim hover:text-coral border border-line rounded-btn px-2 py-1.5 transition-colors"
              title="关闭当前工作区"
            >
              关闭
            </button>
          </>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────── */}
      {!root ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center overflow-y-auto">
          <Mascot mood="idle" size={110} />
          <h1 className="text-xl font-bold text-gradient mt-4 mb-1.5">统一工作区</h1>
          <p className="text-[13px] text-ink-muted mb-6 max-w-md leading-6">
            打开一个文件夹，开始和 AI 一起写代码 —— 左侧文件树、中间编辑器、右侧 AI 对话直接改文件。
          </p>
          <button
            onClick={() => void pickDir()}
            disabled={wsOpening}
            className="px-5 py-2.5 rounded-btn bg-grad-primary text-white text-sm font-medium shadow-glow-primary hover:-translate-y-px transition-all disabled:opacity-40"
          >
            打开文件夹
          </button>
          {noProviders && (
            <p className="text-[11px] text-gold/80 mt-3">
              尚未配置服务商，可浏览/编辑文件，但 AI 对话需先到「设置」添加 API Key。
            </p>
          )}
          {recent.length > 0 && (
            <div className="mt-8 w-full max-w-md">
              <div className="text-[11px] text-ink-dim mb-2 text-left">最近打开</div>
              <div className="flex flex-col gap-1.5">
                {recent.slice(0, 6).map((p) => (
                  <button
                    key={p}
                    onClick={() => void openDir(p)}
                    className="flex items-center gap-2 px-3 py-2 rounded-card glass hover:border-line-strong text-left transition-colors"
                    title={p}
                  >
                    <span>📁</span>
                    <span className="text-[13px] text-ink truncate">{baseName(p)}</span>
                    <span className="text-[11px] text-ink-dim font-mono truncate flex-1">{p}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-1 min-h-0">
            <FileTree />
            <EditorPane />
            <ChatPanel draft={draft} setDraft={setDraft} />
          </div>
          <BottomPanel
            open={bottomOpen}
            tab={bottomTab}
            onTab={setBottomTab}
            onToggle={() => setBottomOpen((v) => !v)}
          />
        </>
      )}

      {/* ── Extensions modal ────────────────────────────────────── */}
      <ExtensionsPanel
        open={extOpen}
        onClose={() => setExtOpen(false)}
        onUseSkill={(text) => setDraft(text)}
      />

      {/* ── Toast ───────────────────────────────────────────────── */}
      {toast && (
        <div
          className={[
            'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-card border text-sm shadow-glass max-w-[80vw] break-words',
            isErr ? 'bg-coral/15 border-coral/40 text-coral' : 'glass-strong text-ink',
          ].join(' ')}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

// 供沉淀页(Sediment)回放复用同一套对话渲染。
export { EntryItem } from '../components/workbench/ChatPanel'
