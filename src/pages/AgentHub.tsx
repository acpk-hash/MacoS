// Agent 板块 — 主 Agent / Subagent 运行总览 + 会话工作流存档。
import { useEffect, useMemo, useState } from 'react'
import { saveExport } from '../lib/exportChat'
import { useAgentHubStore, workflowToMarkdown } from '../stores/agentHubStore'
import type { WorkflowRecord } from '../stores/agentHubStore'
import WorkflowCard from '../components/agenthub/WorkflowCard'
import WorkflowDrawer from '../components/agenthub/WorkflowDrawer'
import { groupByDay } from '../components/agenthub/workflowUtils'
import { useTaskRegistry, MODULE_LABEL } from '../stores/taskRegistryStore'
import { usePiStore, type PiSession, type PiTimelineItem, type PiUsage } from '../stores/piStore'
import { useSubagentStore, type SubagentStatus } from '../stores/subagentStore'
import { invoke } from '@tauri-apps/api/core'

const EMPTY_ITEMS: PiTimelineItem[] = []

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function statusCls(status: string): string {
  if (status === 'running') return 'text-running bg-running/10 border-running/30'
  if (status === 'done') return 'text-done bg-done/10 border-done/30'
  if (status === 'error') return 'text-failed bg-failed/10 border-failed/30'
  if (status === 'stopped') return 'text-ink-dim bg-surface-2 border-line'
  return 'text-ink-dim bg-surface-2 border-line'
}

function statusText(status: string): string {
  if (status === 'running') return '运行中'
  if (status === 'done') return '已完成'
  if (status === 'error') return '出错'
  if (status === 'stopped') return '已停止'
  return '就绪'
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <div className="text-[11px] text-ink-dim">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-faint truncate">{sub}</div>}
    </div>
  )
}

function sessionStats(items: PiTimelineItem[]) {
  let user = 0
  let assistant = 0
  let tools = 0
  let pendingTools = 0
  for (const it of items) {
    if (it.kind === 'user') user++
    else if (it.kind === 'assistant') assistant++
    else if (it.kind === 'tool') {
      tools++
      if (it.running) pendingTools++
    }
  }
  return { user, assistant, tools, pendingTools }
}

function MainAgentRow({ session, items, usage }: { session: PiSession; items: PiTimelineItem[]; usage?: PiUsage }) {
  const st = sessionStats(items)
  const lastTool = [...items].reverse().find((it) => it.kind === 'tool') as Extract<PiTimelineItem, { kind: 'tool' }> | undefined
  return (
    <div className="rounded-card border border-line bg-editor px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-ink" title={session.title}>{session.title}</span>
        <span className={`rounded-chip border px-1.5 py-0.5 text-[10px] ${statusCls(session.status)}`}>{statusText(session.status)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-dim">
        <span className="font-mono" title={session.cwd}>{baseName(session.cwd)}</span>
        <span className="font-mono">{session.model || '默认模型'}</span>
        <span>{st.user} 轮用户输入</span>
        <span>{st.tools} 次工具调用</span>
        {st.pendingTools > 0 && <span className="text-running">{st.pendingTools} 个工具运行中</span>}
      </div>
      {usage && usage.turns > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
          <div className="rounded bg-surface-2 px-1.5 py-1"><div className="text-[10px] text-ink-faint">输入</div><div className="text-[11px] text-ink">{fmtTokens(usage.input)}</div></div>
          <div className="rounded bg-surface-2 px-1.5 py-1"><div className="text-[10px] text-ink-faint">输出</div><div className="text-[11px] text-ink">{fmtTokens(usage.output)}</div></div>
          <div className="rounded bg-surface-2 px-1.5 py-1"><div className="text-[10px] text-ink-faint">轮次</div><div className="text-[11px] text-ink">{usage.turns}</div></div>
          <div className="rounded bg-surface-2 px-1.5 py-1"><div className="text-[10px] text-ink-faint">费用</div><div className="text-[11px] text-ink">${usage.cost.toFixed(4)}</div></div>
        </div>
      )}
      {lastTool && (
        <div className="mt-2 rounded bg-surface border border-line px-2 py-1 text-[11px] text-ink-muted">
          当前/最近工具：<span className="font-mono text-ink">{lastTool.toolName}</span>
          {lastTool.running && <span className="ml-2 text-running">运行中</span>}
        </div>
      )}
    </div>
  )
}

function SubagentMiniBoard() {
  const agents = useSubagentStore((s) => s.agents)
  const eventsById = useSubagentStore((s) => s.eventsById)
  const init = useSubagentStore((s) => s.init)
  const refresh = useSubagentStore((s) => s.refresh)
  const stop = useSubagentStore((s) => s.stop)

  useEffect(() => {
    void init()
    void refresh()
  }, [init, refresh])

  const byStatus = useMemo(() => {
    const m: Record<SubagentStatus, number> = { running: 0, done: 0, error: 0, stopped: 0 }
    for (const a of agents) m[a.status]++
    return m
  }, [agents])

  return (
    <section className="rounded-card border border-line bg-surface min-h-0 flex flex-col">
      <div className="px-3 py-2 border-b border-line flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-ink flex-1">Subagents</h2>
        <span className="text-[10.5px] text-running">运行 {byStatus.running}</span>
        <span className="text-[10.5px] text-done">完成 {byStatus.done}</span>
        <span className="text-[10.5px] text-failed">错误 {byStatus.error}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {agents.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-[12px] text-ink-dim">暂无并行子任务</div>
        ) : agents.map((a) => {
          const events = eventsById[a.id] ?? []
          const last = events[events.length - 1]
          return (
            <div key={a.id} className="rounded-card border border-line bg-editor px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-[12px] text-ink" title={a.title}>{a.title}</span>
                <span className={`rounded-chip border px-1.5 py-0.5 text-[10px] ${statusCls(a.status)}`}>{statusText(a.status)}</span>
              </div>
              <div className="mt-1 text-[10.5px] text-ink-dim truncate font-mono" title={a.cwd}>{baseName(a.cwd)} · {a.model}</div>
              <div className="mt-1 text-[10.5px] text-ink-faint">事件 {events.length}{last ? ' · 最近 ' + last.kind : ''}</div>
              {a.status === 'running' && <button onClick={() => void stop(a.id)} className="mt-1.5 rounded-btn border border-failed/30 px-2 py-0.5 text-[10.5px] text-failed hover:bg-failed/10">停止</button>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

interface IntegrationStatus {
  id: string
  name: string
  repo: string
  license: string
  capability: string
  path: string
  source_ready: boolean
  prerequisites_ready: boolean
  missing_prerequisites: string[]
  installed: boolean
  install_command: string
  launch_command: string
  local_url: string | null
}

interface IntegrationCommandResult {
  success: boolean
  output: string
}

function ExternalIntegrationMap() {
  const [items, setItems] = useState<IntegrationStatus[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const load = async () => {
    try { setItems(await invoke<IntegrationStatus[]>('integrations_list')) }
    catch (e) { setLog(String(e)) }
  }
  useEffect(() => { void load() }, [])

  const action = async (id: string, command: 'integration_install' | 'integration_launch') => {
    setBusy(id + command)
    setLog(null)
    try {
      const result = await invoke<IntegrationCommandResult>(command, { id })
      setLog(result.output || (result.success ? '操作完成' : '操作失败'))
      await load()
    } catch (e) { setLog(String(e)) }
    finally { setBusy(null) }
  }

  const openUrl = async (url: string) => {
    try { await invoke('open_external_url', { url }) }
    catch { window.open(url, '_blank') }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-3">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-[13px] font-semibold text-ink flex-1">外部能力适配器</h2>
        <span className="text-[10.5px] text-ink-dim">源码 {items.filter((x) => x.source_ready).length}/{items.length || 9} · 可启动 {items.filter((x) => x.installed && x.prerequisites_ready).length}</span>
        <button onClick={() => void load()} className="rounded-btn border border-line px-2 py-1 text-[10.5px] text-ink-muted hover:text-ink">刷新</button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item.id} className="rounded-card bg-editor border border-line px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="text-[11.5px] font-mono font-semibold text-ink flex-1">{item.name}</div>
              <span className="text-[9.5px] rounded-chip border border-line px-1.5 py-0.5 text-ink-dim">{item.license}</span>
              <span className={item.source_ready ? 'text-[10px] text-done' : 'text-[10px] text-failed'}>{item.source_ready ? '源码就绪' : '未部署'}</span>
              <span className={item.installed ? 'text-[10px] text-done' : 'text-[10px] text-running'}>{item.installed ? '依赖就绪' : '待安装'}</span>
            </div>
            <div className="mt-1 text-[10.5px] text-ink-dim">{item.capability}</div>
            <div className="mt-1 truncate font-mono text-[9.5px] text-ink-faint" title={item.path}>{item.path}</div>
            {!item.prerequisites_ready && <div className="mt-1 text-[10px] text-failed">缺少：{item.missing_prerequisites.join(', ')}</div>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button onClick={() => void invoke('integration_open_dir', { id: item.id })} disabled={!item.source_ready} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-ink-muted disabled:opacity-40">目录</button>
              {item.install_command && <button onClick={() => void action(item.id, 'integration_install')} disabled={!item.source_ready || !item.prerequisites_ready || busy !== null} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-primary disabled:opacity-40">{busy === item.id + 'integration_install' ? '安装中...' : item.installed ? '重新安装' : '安装依赖'}</button>}
              {item.launch_command && <button onClick={() => void action(item.id, 'integration_launch')} disabled={!item.source_ready || !item.prerequisites_ready || busy !== null} className="rounded-btn bg-primary px-2 py-0.5 text-[10.5px] text-white disabled:opacity-40">{busy === item.id + 'integration_launch' ? '启动中...' : '启动'}</button>}
              {item.local_url && <button onClick={() => void openUrl(item.local_url!)} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-ink-muted">访问</button>}
            </div>
          </div>
        ))}
      </div>
      {log && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-2 border border-line p-2 text-[10px] text-ink-muted">{log}</pre>}
    </section>
  )
}

export default function AgentHub() {
  const records = useAgentHubStore((s) => s.records)
  const removeRecord = useAgentHubStore((s) => s.removeRecord)
  const piInit = usePiStore((s) => s.init)
  const sessions = usePiStore((s) => s.sessions)
  const timelineById = usePiStore((s) => s.timelineById)
  const usageById = usePiStore((s) => s.usageById)
  const tasks = useTaskRegistry((s) => s.tasks)
  const clearFinished = useTaskRegistry((s) => s.clearFinished)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => { void piInit() }, [piInit])
  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(null), 3000)
    return () => clearTimeout(t)
  }, [hint])

  const runningTasks = tasks.filter((t) => t.status === 'running')
  const finishedTasks = tasks.filter((t) => t.status === 'done' || t.status === 'error')
  const runningSessions = sessions.filter((s) => s.status === 'running')
  const totalUsage = Object.values(usageById).reduce((acc, u) => ({
    input: acc.input + u.input,
    output: acc.output + u.output,
    cost: acc.cost + u.cost,
    turns: acc.turns + u.turns,
  }), { input: 0, output: 0, cost: 0, turns: 0 })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return records
    return records.filter((r) => {
      if (r.title.toLowerCase().includes(q)) return true
      if (r.cwd.toLowerCase().includes(q)) return true
      if (r.fullPromptChain.some((p) => p.toLowerCase().includes(q))) return true
      return r.steps.some((s) => s.summary.toLowerCase().includes(q))
    })
  }, [records, query])

  const groups = useMemo(() => groupByDay(filtered), [filtered])
  const selected = selectedId ? records.find((r) => r.id === selectedId) ?? null : null

  const handleExport = async (rec: WorkflowRecord) => {
    try {
      const ok = await saveExport(rec.title, 'md', workflowToMarkdown(rec))
      if (ok) setHint(`已导出「${rec.title}」`)
    } catch (e) {
      setHint(`导出失败：${String(e)}`)
    }
  }

  const handleDelete = (rec: WorkflowRecord) => {
    if (!window.confirm(`删除工作流存档「${rec.title}」？此操作不可恢复。`)) return
    removeRecord(rec.id)
    if (selectedId === rec.id) setSelectedId(null)
  }

  return (
    <div className="h-full overflow-y-auto bg-editor">
      <div className="mx-auto max-w-7xl px-6 py-6 space-y-4">
        <header className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink">Agent</h1>
            <p className="mt-1 text-sm text-ink-muted">主 Agent / Subagent 运行形态、用量与工作流复用</p>
          </div>
          <div className="flex-1" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索历史工作流…" className="w-72 max-w-full px-3 py-1.5 rounded-input border border-line bg-surface text-[12px] text-ink placeholder:text-ink-faint outline-none focus:border-primary/60" />
        </header>
        {hint && <div className="text-[11px] text-done">{hint}</div>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card label="主 Agent 会话" value={String(sessions.length)} sub={`运行中 ${runningSessions.length}`} />
          <Card label="全局任务" value={String(tasks.length)} sub={`运行 ${runningTasks.length} · 结束 ${finishedTasks.length}`} />
          <Card label="本次用量" value={fmtTokens(totalUsage.input + totalUsage.output)} sub={`${totalUsage.turns} 轮 · $${totalUsage.cost.toFixed(4)}`} />
          <Card label="工作流存档" value={String(records.length)} sub="完成后自动归档" />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)] gap-4 min-h-[420px]">
          <section className="rounded-card border border-line bg-surface min-h-0 flex flex-col">
            <div className="px-3 py-2 border-b border-line flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-ink flex-1">主 Agent 会话</h2>
              <span className="text-[10.5px] text-ink-dim">每个对话的进度与用量</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {sessions.length === 0 ? <div className="h-56 flex items-center justify-center text-[12px] text-ink-dim">暂无主 Agent 会话。到「编码」新建会话后会显示在这里。</div> :
                sessions.slice().reverse().map((s) => <MainAgentRow key={s.id} session={s} items={timelineById[s.id] ?? EMPTY_ITEMS} usage={usageById[s.id]} />)}
            </div>
          </section>
          <SubagentMiniBoard />
        </div>

        <ExternalIntegrationMap />

        <section className="rounded-card border border-line bg-surface">
          <div className="px-3 py-2 border-b border-line flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink flex-1">历史工作流存档</h2>
            <span className="text-[10.5px] text-ink-dim">{filtered.length} / {records.length}</span>
          </div>
          <div className="p-3">
            {records.length === 0 ? <div className="min-h-[180px] flex items-center justify-center text-[12px] text-ink-dim">完成一次编码会话后，工作流将自动存档。</div> : filtered.length === 0 ? <div className="min-h-[120px] flex items-center justify-center text-[12px] text-ink-dim">没有匹配「{query.trim()}」的工作流</div> : groups.map((g) => (
              <div key={g.label} className="mb-5 last:mb-0">
                <div className="mb-2 text-[11px] font-medium text-ink-dim select-none">{g.label}</div>
                <div className="space-y-2">{g.items.map((r) => <WorkflowCard key={r.id} rec={r} onOpen={() => setSelectedId(r.id)} onExport={() => void handleExport(r)} onDelete={() => handleDelete(r)} />)}</div>
              </div>
            ))}
          </div>
        </section>

        {finishedTasks.length > 0 && (
          <section className="rounded-card border border-line bg-surface p-3">
            <div className="mb-2 text-[11px] font-medium text-ink-dim select-none">全板块已完成任务 <button onClick={clearFinished} className="ml-2 text-primary hover:underline">清除</button></div>
            <div className="space-y-1.5">{finishedTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-2 rounded-card border border-line bg-editor">
                <span className={['inline-block px-1.5 py-0.5 rounded text-[10px] font-medium', t.status === 'done' ? 'bg-done/10 text-done' : 'bg-failed/10 text-failed'].join(' ')}>{MODULE_LABEL[t.module]}</span>
                <span className="text-[12px] text-ink truncate flex-1">{t.title}</span>
                {t.detail && <span className="text-[11px] text-ink-muted truncate max-w-[260px]">{t.detail}</span>}
                <span className="text-[10px] text-ink-faint">{new Date(t.updatedAt).toLocaleTimeString()}</span>
              </div>
            ))}</div>
          </section>
        )}
      </div>

      {selected && <WorkflowDrawer rec={selected} onClose={() => setSelectedId(null)} onExport={() => void handleExport(selected)} onDelete={() => handleDelete(selected)} />}
    </div>
  )
}
