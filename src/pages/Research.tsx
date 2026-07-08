import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Editor from '@monaco-editor/react'
import { MONACO_THEME } from '../lib/monacoSetup'
import { Mascot, StatusDot } from '../components/ui'
import type { StatusKind } from '../components/ui/StatusDot'
import { useWorkbenchStore } from '../stores/workbenchStore'
import {
  useResearchStore,
  type MdMeta,
  type PipelineInfo,
  type DashboardRun,
  type RunArtifact,
  type ResearchTab,
} from '../stores/researchStore'

const NL = String.fromCharCode(10)

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function convertPath(p: string): Promise<string> {
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(p)
  } catch {
    return p
  }
}

function fmtDate(s: string): string {
  if (!s) return ''
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}

function runStatusKind(s: string): StatusKind {
  if (s === 'completed' || s === 'success' || s === 'done') return 'done'
  if (s === 'running' || s === 'active' || s === 'in_progress') return 'running'
  if (s === 'failed' || s === 'error') return 'failed'
  return 'idle'
}

const RUN_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  success: '成功',
  running: '运行中',
  active: '进行中',
  in_progress: '进行中',
  failed: '失败',
  error: '出错',
  draft_complete: '草稿完成',
}
function runStatusLabel(s: string): string {
  return RUN_STATUS_LABEL[s] ?? s
}

const CARD =
  'bg-surface border border-line rounded-card shadow-card transition-all duration-150'
const CARD_HOVER =
  CARD + ' hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop'

function MdEditorOverlay({
  meta,
  initial,
  onClose,
  onSave,
  onUse,
  useLabel,
}: {
  meta: MdMeta
  initial: string
  onClose: () => void
  onSave: (content: string) => Promise<void>
  onUse: () => void
  useLabel: string
}) {
  const [content, setContent] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const dirty = content !== initial

  const doSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      await onSave(content)
      setSaveMsg('已保存')
    } catch (e) {
      setSaveMsg('保存失败：' + String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40" onClick={onClose}>
      <div
        className="ml-auto h-full w-full max-w-3xl bg-bg border-l border-line flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
          <div className="min-w-0">
            <div className="text-[14px] text-ink font-semibold truncate">
              {meta.title}
            </div>
            <div className="text-[10px] text-ink-dim font-mono truncate" title={meta.path}>
              {meta.path}
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={onUse}
            className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors flex-shrink-0"
            title="打开工作台,用该定义开一轮"
          >
            {useLabel}
          </button>
          <button
            onClick={doSave}
            disabled={!dirty || saving}
            className="text-[11px] px-2.5 py-1 rounded-md bg-surface-2 border border-line text-ink hover:bg-elevated disabled:opacity-40 transition-colors flex-shrink-0"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            onClick={onClose}
            className="text-ink-dim hover:text-ink text-lg leading-none px-1 flex-shrink-0"
            title="关闭"
          >
            ✕
          </button>
        </div>
        {saveMsg && (
          <div className="px-4 py-1.5 text-[11px] text-ink-muted border-b border-line/60">
            {saveMsg}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <Editor
            theme={MONACO_THEME}
            language="markdown"
            value={content}
            onChange={(v) => setContent(v ?? '')}
            options={{
              fontSize: 12.5,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 8, bottom: 8 },
              tabSize: 2,
              automaticLayout: true,
            }}
            loading={<div className="p-4 text-[12px] text-ink-dim">编辑器加载中…</div>}
          />
        </div>
      </div>
    </div>
  )
}

function MdCard({ meta, onOpen }: { meta: MdMeta; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={CARD_HOVER + ' p-4 flex flex-col text-left w-full'}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[13.5px] text-ink font-semibold truncate">
          {meta.title}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-tint text-primary font-medium">
          {meta.category}
        </span>
        <span className="text-[10px] text-ink-dim font-mono truncate">{meta.name}</span>
      </div>
      <p className="text-[12px] text-ink-muted leading-5 line-clamp-3 flex-1">
        {meta.description || '（无描述）'}
      </p>
    </button>
  )
}

function PipelineCard({
  pipeline,
  onRun,
}: {
  pipeline: PipelineInfo
  onRun: (input: string) => void
}) {
  const [input, setInput] = useState('')
  return (
    <div className={CARD + ' p-4 flex flex-col'}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[13.5px] text-ink font-semibold truncate">
          {pipeline.name}
        </span>
        <span
          className={
            'ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ' +
            (pipeline.source === 'skill'
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-indigo-100 text-indigo-700')
          }
        >
          {pipeline.source === 'skill' ? 'skill' : 'agent'}
        </span>
      </div>
      <p className="text-[12px] text-ink-muted leading-5 line-clamp-2 mb-2">
        {pipeline.description || '（无描述）'}
      </p>
      {pipeline.steps.length > 0 && (
        <div className="text-[11px] text-ink-dim font-mono leading-5 mb-2 line-clamp-2">
          {pipeline.steps.join(' → ')}
        </div>
      )}
      <div className="mt-auto flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="主题 / 输入(可选)"
          className="flex-1 min-w-0 bg-surface border border-line rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors"
        />
        <button
          onClick={() => onRun(input)}
          className="text-[11px] px-3 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors flex-shrink-0"
          title="进工作台运行该流水线"
        >
          运行
        </button>
      </div>
    </div>
  )
}

function ArtifactButtons({ artifacts }: { artifacts: RunArtifact[] }) {
  const readRunOutput = useResearchStore((s) => s.readRunOutput)
  const [text, setText] = useState<{ kind: string; body: string } | null>(null)

  const open = async (a: RunArtifact) => {
    if (a.kind === 'pdf') {
      const url = await convertPath(a.path)
      window.open(url, '_blank')
      return
    }
    if (a.kind === 'html') {
      try {
        const body = await readRunOutput(a.path)
        const blob = new Blob([body], { type: 'text/html' })
        window.open(URL.createObjectURL(blob), '_blank')
      } catch {
        const url = await convertPath(a.path)
        window.open(url, '_blank')
      }
      return
    }
    try {
      const body = await readRunOutput(a.path)
      setText({ kind: a.kind, body })
    } catch (e) {
      setText({ kind: a.kind, body: '读取失败：' + String(e) })
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {artifacts.length === 0 && (
          <span className="text-[10px] text-ink-dim">（无产物）</span>
        )}
        {artifacts.map((a) => (
          <button
            key={a.path}
            onClick={() => open(a)}
            className="text-[10.5px] px-2 py-0.5 rounded bg-surface-2 border border-line text-ink-muted hover:text-primary hover:border-primary/60 transition-colors font-mono"
            title={a.path}
          >
            {a.kind.toUpperCase()}
          </button>
        ))}
      </div>
      {text && (
        <div
          className="fixed inset-0 z-50 flex bg-black/40"
          onClick={() => setText(null)}
        >
          <div
            className="ml-auto h-full w-full max-w-2xl bg-bg border-l border-line flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
              <span className="text-[13px] text-ink font-semibold">
                产物预览 · {text.kind.toUpperCase()}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setText(null)}
                className="text-ink-dim hover:text-ink text-lg leading-none px-1"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-[11.5px] text-ink-muted font-mono whitespace-pre-wrap">
              {text.body}
            </pre>
          </div>
        </div>
      )}
    </>
  )
}

function RunCard({ run }: { run: DashboardRun }) {
  return (
    <div className={CARD + ' p-4 flex flex-col'}>
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot status={runStatusKind(run.status)} pulse={run.status === 'running'} />
        <span className="text-[13px] text-ink font-semibold truncate">
          {run.title}
        </span>
        <span className="ml-auto text-[10px] text-ink-dim flex-shrink-0">
          {fmtDate(run.updated_at || run.created_at)}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-tint text-primary font-medium">
          {runStatusLabel(run.status)}
        </span>
        {run.current_stage && (
          <span className="text-[10px] text-ink-dim font-mono">
            阶段: {run.current_stage}
          </span>
        )}
        <span className="ml-auto text-[10px] text-ink-dim font-mono">{run.id}</span>
      </div>
      {run.stages.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2.5">
          {run.stages.map((st, i) => (
            <span
              key={i}
              className={
                'text-[9.5px] px-1.5 py-0.5 rounded font-medium ' +
                (st.status === 'completed'
                  ? 'bg-emerald-100 text-emerald-700'
                  : st.status === 'running'
                    ? 'bg-primary-tint text-primary'
                    : 'bg-surface-2 text-ink-dim')
              }
              title={st.status + ' · ' + st.progress + '%'}
            >
              {st.title}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto pt-1 border-t border-line/60">
        <div className="text-[10px] text-ink-dim mb-1">产物</div>
        <ArtifactButtons artifacts={run.artifacts} />
      </div>
    </div>
  )
}

function DashboardTab() {
  const { dashboard, dashboardLoading, loadDashboard } = useResearchStore()

  useEffect(() => {
    if (!dashboard) void loadDashboard()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (dashboardLoading && !dashboard) {
    return <div className="p-4 text-[12px] text-ink-dim">加载中…</div>
  }
  if (!dashboard) {
    return <div className="p-4 text-[12px] text-ink-dim">暂无仪表盘数据</div>
  }

  const activeSkills = dashboard.skills.filter((s) => s.runs > 0)

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div className="flex flex-wrap gap-3">
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">知识库论文</div>
          <div className="text-[20px] font-bold text-ink">{dashboard.kb_total_papers}</div>
        </div>
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">知识库大小</div>
          <div className="text-[20px] font-bold text-ink">
            {dashboard.kb_total_size_mb.toFixed(1)} MB
          </div>
        </div>
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">运行记录</div>
          <div className="text-[20px] font-bold text-ink">{dashboard.runs.length}</div>
        </div>
        <div className={CARD + ' px-4 py-3 flex-1 min-w-[160px]'}>
          <div className="text-[11px] text-ink-dim">最近扫描</div>
          <div className="text-[12px] font-medium text-ink mt-1.5">
            {dashboard.kb_last_scan ? fmtDate(dashboard.kb_last_scan) : '—'}
          </div>
        </div>
      </div>

      <section>
        <h2 className="text-[13px] font-semibold text-ink mb-2">工作流运行</h2>
        {dashboard.runs.length === 0 ? (
          <div className="text-[12px] text-ink-dim">还没有运行记录</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {dashboard.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>

      {activeSkills.length > 0 && (
        <section>
          <h2 className="text-[13px] font-semibold text-ink mb-2">技能运行统计</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {activeSkills.map((sk) => (
              <div
                key={sk.name}
                className={CARD + ' px-3 py-2 flex items-center gap-2'}
              >
                <StatusDot status={sk.status === 'running' ? 'running' : 'idle'} />
                <span className="text-[12px] text-ink font-mono truncate">{sk.name}</span>
                <span className="ml-auto text-[11px] text-ink-dim">
                  {sk.successes}/{sk.runs} 次
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-[13px] font-semibold text-ink mb-2">近期执行日志</h2>
        {dashboard.logs.length === 0 ? (
          <div className="text-[12px] text-ink-dim">暂无日志</div>
        ) : (
          <div className="space-y-1.5">
            {dashboard.logs.map((log, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-[11.5px] px-3 py-1.5 rounded-lg bg-surface border border-line"
              >
                <StatusDot status={log.status === 'success' ? 'done' : 'idle'} />
                <span className="text-ink font-mono">{log.skill}</span>
                <span className="text-ink-muted truncate">{log.summary}</span>
                <span className="ml-auto text-ink-dim flex-shrink-0">
                  {fmtDate(log.finished)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default function Research() {
  const navigate = useNavigate()
  const store = useResearchStore()
  const requestReuse = useWorkbenchStore((s) => s.requestReuse)

  const [tab, setTab] = useState<ResearchTab>('agents')
  const [editing, setEditing] = useState<{
    meta: MdMeta
    initial: string
    kind: 'agent' | 'skill'
  } | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void store.loadRoots()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'agents' && !store.agentsLoaded) void store.loadAgents()
    if (tab === 'skills' && !store.skillsLoaded) void store.loadSkills()
    if (tab === 'pipelines' && !store.pipelinesLoaded) void store.loadPipelines()
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const openAgent = async (meta: MdMeta) => {
    try {
      const initial = await store.readAgent(meta.path)
      setEditing({ meta, initial, kind: 'agent' })
    } catch (e) {
      useResearchStore.setState({ error: '读取失败：' + String(e) })
    }
  }
  const openSkill = async (meta: MdMeta) => {
    try {
      const initial = await store.readSkill(meta.path)
      setEditing({ meta, initial, kind: 'skill' })
    } catch (e) {
      useResearchStore.setState({ error: '读取失败：' + String(e) })
    }
  }

  const useInWorkbench = (meta: MdMeta) => {
    const cwd =
      editing?.kind === 'skill'
        ? store.roots?.skills_root ?? ''
        : store.roots?.agents_root ?? ''
    const kindLabel = editing?.kind === 'skill' ? 'skill' : 'agent'
    const prompt =
      '请以下面这个科研 ' +
      kindLabel +
      '「' +
      meta.title +
      '」(' +
      meta.name +
      ') 的定义来完成任务。定义文件位于:' +
      NL +
      meta.path +
      NL +
      NL +
      meta.description
    requestReuse({ cwd, model: '', prompt })
    setEditing(null)
    navigate('/workbench')
  }

  const runPipeline = async (pl: PipelineInfo, input: string) => {
    try {
      const launch = await store.runPipeline(pl.id, input)
      requestReuse({ cwd: launch.cwd, model: '', prompt: launch.prompt })
      navigate('/workbench')
    } catch (e) {
      useResearchStore.setState({ error: '运行失败：' + String(e) })
    }
  }

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return store.agents
    return store.agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    )
  }, [store.agents, query])

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return store.skills
    return store.skills.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    )
  }, [store.skills, query])

  const skillsByCategory = useMemo(() => {
    const map = new Map<string, MdMeta[]>()
    for (const sk of filteredSkills) {
      const arr = map.get(sk.category) ?? []
      arr.push(sk)
      map.set(sk.category, arr)
    }
    return Array.from(map.entries())
  }, [filteredSkills])

  const TabButton = ({ id, label }: { id: ResearchTab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={
        'px-3 py-1.5 text-[13px] rounded-lg transition-colors ' +
        (tab === id ? 'bg-primary-tint text-primary font-semibold' : 'text-ink-dim hover:text-ink')
      }
    >
      {label}
    </button>
  )

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold text-gradient mr-2">科研</h1>
          <TabButton id="agents" label="Agent 库" />
          <TabButton id="skills" label="Skill 库" />
          <TabButton id="pipelines" label="流水线" />
          <TabButton id="dashboard" label="仪表盘" />
        </div>
        <p className="text-[11px] text-ink-dim mt-1">
          集成本地 agent管理 / skills管理:浏览编辑 agent·skill 定义、运行流水线、查看运行仪表盘。
        </p>
      </header>

      {store.error && (
        <div className="px-4 py-2 text-[12px] text-red-600 border-b border-line/60">
          {store.error}
        </div>
      )}

      {(tab === 'agents' || tab === 'skills') && (
        <div className="px-4 py-2.5 border-b border-line flex-shrink-0">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 分类 / 描述"
            className="w-full max-w-md bg-surface border border-line rounded-lg px-3 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors"
          />
        </div>
      )}

      {tab === 'agents' && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {store.agentsLoading && store.agents.length === 0 ? (
            <div className="text-[12px] text-ink-dim">扫描中…</div>
          ) : filteredAgents.length === 0 ? (
            <EmptyState label="没有找到 agent" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredAgents.map((a) => (
                <MdCard key={a.path} meta={a} onOpen={() => void openAgent(a)} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'skills' && (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {store.skillsLoading && store.skills.length === 0 ? (
            <div className="text-[12px] text-ink-dim">扫描中…</div>
          ) : filteredSkills.length === 0 ? (
            <EmptyState label="没有找到 skill" />
          ) : (
            skillsByCategory.map(([cat, items]) => (
              <section key={cat}>
                <h2 className="text-[12.5px] font-semibold text-ink-muted mb-2 uppercase tracking-wide">
                  {cat}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {items.map((sk) => (
                    <MdCard key={sk.path} meta={sk} onOpen={() => void openSkill(sk)} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {tab === 'pipelines' && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {store.pipelinesLoading && store.pipelines.length === 0 ? (
            <div className="text-[12px] text-ink-dim">加载中…</div>
          ) : store.pipelines.length === 0 ? (
            <EmptyState label="没有可运行的流水线" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {store.pipelines.map((p) => (
                <PipelineCard
                  key={p.source + ':' + p.id}
                  pipeline={p}
                  onRun={(input) => void runPipeline(p, input)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'dashboard' && <DashboardTab />}

      {editing && (
        <MdEditorOverlay
          meta={editing.meta}
          initial={editing.initial}
          useLabel="在工作台使用"
          onClose={() => setEditing(null)}
          onUse={() => useInWorkbench(editing.meta)}
          onSave={async (content) => {
            if (editing.kind === 'agent') await store.writeAgent(editing.meta.path, content)
            else await store.writeSkill(editing.meta.path, content)
          }}
        />
      )}
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-20">
      <Mascot mood="idle" size={72} className="mb-4" />
      <p className="text-ink-muted text-sm">{label}</p>
      <p className="text-ink-dim text-xs mt-1">
        {isTauri
          ? '确认源目录存在,或在后端设置里调整根路径。'
          : '在 Tauri 应用内可用。'}
      </p>
    </div>
  )
}
