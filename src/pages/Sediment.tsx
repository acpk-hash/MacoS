import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useSedimentStore,
  rebuildEntries,
  boardEventsMap,
  type RunSummary,
  type RunKind,
  type RunDetail,
  type SkillInfo,
  type FilterKind,
} from '../stores/sedimentStore'
import { useWorkbenchStore } from '../stores/workbenchStore'
import { EntryItem } from './Workbench'
import { buildFlow } from '../components/canvas/buildFlow'
import SessionBlock from '../components/canvas/SessionBlock'
import { Mascot } from '../components/ui'

// ── Formatting helpers ──────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '')
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '')
}

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ms)
  }
}

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  ended: '已结束',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  awaiting_review: '待确认',
  queued: '排队中',
}

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s
}

function statusClass(s: string): string {
  if (s === 'failed') return 'bg-red-100 text-red-600'
  if (s === 'running' || s === 'active') return 'bg-sakura/25 text-sky'
  if (s === 'awaiting_review') return 'bg-amber-100 text-amber-600'
  return 'bg-elevated/60 text-ink-muted'
}

function KindBadge({ kind }: { kind: RunKind }) {
  const isBoard = kind === 'board'
  return (
    <span
      className={[
        'text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0',
        isBoard ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700',
      ].join(' ')}
    >
      {isBoard ? '看板' : '工作台'}
    </span>
  )
}

// ── Run card ────────────────────────────────────────────────────────────────────

function RunCard({
  run,
  onOpen,
  onReuse,
  onDelete,
}: {
  run: RunSummary
  onOpen: () => void
  onReuse: () => void
  onDelete: () => void
}) {
  return (
    <div className="glass rounded-card hover:-translate-y-0.5 hover:border-line-strong transition-all duration-150 overflow-hidden">
      <button onClick={onOpen} className="w-full text-left px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <KindBadge kind={run.kind} />
          <span className={'text-[10px] px-1.5 py-0.5 rounded ' + statusClass(run.status)}>
            {statusLabel(run.status)}
          </span>
          <span className="ml-auto text-[10px] text-ink-dim flex-shrink-0">
            {fmtDate(run.created_at)}
          </span>
        </div>
        <div className="text-[13.5px] text-ink font-medium line-clamp-2 break-words">
          {run.title || '未命名运行'}
        </div>
        <div className="mt-1 text-[11px] text-ink-dim font-mono truncate" title={run.cwd}>
          {run.cwd || '—'}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
          {run.model && <span className="font-mono text-ink-muted">🧠 {run.model}</span>}
          {run.total_tokens != null && (
            <span className="font-mono">Σ {fmtTokens(run.total_tokens)}</span>
          )}
          <span>📝 {run.files_changed} 文件</span>
          {run.duration_ms != null && <span>⏱ {fmtDuration(run.duration_ms)}</span>}
        </div>
      </button>
      <div className="flex items-center gap-1 px-3 py-2 border-t border-line/70 bg-surface/40">
        <button
          onClick={onReuse}
          className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-600/80 hover:bg-emerald-600 text-white transition-colors"
          title="以同样的工作目录 / 模型重开一个工作台会话，并预填最初的指令"
        >
          复用
        </button>
        <div className="flex-1" />
        <button
          onClick={onDelete}
          className="text-[11px] px-2.5 py-1 rounded-md text-ink-dim hover:text-red-600 hover:bg-red-950/40 transition-colors"
          title="从沉淀库中删除该运行记录"
        >
          删除
        </button>
      </div>
    </div>
  )
}

// ── Run detail overlay ──────────────────────────────────────────────────────────

function BoardDetail({ detail }: { detail: Extract<RunDetail, { kind: 'board' }> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const flow = useMemo(
    () =>
      buildFlow({
        sessions: detail.sessions,
        eventsMap: boardEventsMap(detail.events),
        storeStatus: {},
      }),
    [detail],
  )
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  if (flow.length === 0) {
    return <div className="text-[12px] text-ink-dim">该任务暂无会话记录</div>
  }
  return (
    <div className="space-y-4">
      {flow.map((sess) => (
        <SessionBlock key={sess.id} sess={sess} expanded={expanded} onToggleStep={toggle} />
      ))}
    </div>
  )
}

function WorkbenchDetail({ detail }: { detail: Extract<RunDetail, { kind: 'workbench' }> }) {
  const entries = useMemo(() => rebuildEntries(detail.entries), [detail])
  if (entries.length === 0) {
    return <div className="text-[12px] text-ink-dim">该会话没有可回放的内容</div>
  }
  return (
    <div className="max-w-4xl">
      {entries.map((e) => (
        <EntryItem key={e.id} entry={e} />
      ))}
    </div>
  )
}

function DetailOverlay({
  run,
  detail,
  loading,
  error,
  onClose,
  onReuse,
}: {
  run: RunSummary
  detail: RunDetail | null
  loading: boolean
  error: string | null
  onClose: () => void
  onReuse: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex bg-black/60" onClick={onClose}>
      <div
        className="ml-auto h-full w-full max-w-3xl bg-bg border-l border-line flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line flex-shrink-0">
          <KindBadge kind={run.kind} />
          <div className="min-w-0">
            <div className="text-[13px] text-ink font-medium truncate">
              {run.title || '未命名运行'}
            </div>
            <div className="text-[10px] text-ink-dim font-mono truncate" title={run.cwd}>
              {run.cwd}
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={onReuse}
            className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-600/80 hover:bg-emerald-600 text-white transition-colors flex-shrink-0"
          >
            复用
          </button>
          <button
            onClick={onClose}
            className="text-ink-dim hover:text-ink text-lg leading-none px-1 flex-shrink-0"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading && <div className="text-[12px] text-ink-dim">加载中…</div>}
          {error && <div className="text-[12px] text-red-600">{error}</div>}
          {!loading && !error && detail && detail.kind === 'workbench' && (
            <WorkbenchDetail detail={detail} />
          )}
          {!loading && !error && detail && detail.kind === 'board' && (
            <BoardDetail detail={detail} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Skills tab ──────────────────────────────────────────────────────────────────

function SkillCard({ skill, onUse }: { skill: SkillInfo; onUse: () => void }) {
  return (
    <div className="glass rounded-card p-4 flex flex-col hover:-translate-y-0.5 hover:border-line-strong transition-all duration-150">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[13.5px] text-ink font-medium truncate">
          {skill.name}
        </span>
        <span
          className={[
            'text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0',
            skill.source === 'pi'
              ? 'bg-sky-100 text-sky-600'
              : 'bg-violet-600/25 text-violet-300',
          ].join(' ')}
        >
          {skill.source}
        </span>
      </div>
      <p className="text-[12px] text-ink-muted leading-5 line-clamp-3 flex-1">
        {skill.description || '（无描述）'}
      </p>
      <div className="mt-2 text-[10px] text-ink-dim font-mono truncate" title={skill.path}>
        {skill.path}
      </div>
      <div className="mt-3">
        <button
          onClick={onUse}
          className="text-[11px] px-2.5 py-1 rounded-md bg-surface-2 hover:bg-elevated border border-line text-ink transition-colors"
          title="打开工作台，在本地用这个技能开一轮"
        >
          在工作台使用
        </button>
      </div>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────────

type Tab = 'runs' | 'skills'

export default function Sediment() {
  const navigate = useNavigate()
  const {
    runs,
    runsLoading,
    runsError,
    filterKind,
    query,
    skills,
    skillsLoaded,
    skillsLoading,
    skillsError,
    setFilterKind,
    setQuery,
    loadRuns,
    loadSkills,
    loadDetail,
    reuse,
    deleteRun,
  } = useSedimentStore()
  const requestReuse = useWorkbenchStore((s) => s.requestReuse)

  const [tab, setTab] = useState<Tab>('runs')
  const [detailRun, setDetailRun] = useState<RunSummary | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    void loadRuns()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'skills' && !skillsLoaded) void loadSkills()
  }, [tab, skillsLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (run: RunSummary) => {
    setDetailRun(run)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const d = await loadDetail(run.kind, run.id)
      setDetail(d)
    } catch (e) {
      setDetailError('详情加载失败：' + String(e))
    } finally {
      setDetailLoading(false)
    }
  }

  const doReuse = async (run: RunSummary) => {
    try {
      const info = await reuse(run.kind, run.id)
      requestReuse({ cwd: info.cwd, model: info.model, prompt: info.first_prompt })
      setDetailRun(null)
      navigate('/workbench')
    } catch (e) {
      useSedimentStore.setState({ runsError: '复用失败：' + String(e) })
    }
  }

  const doDelete = async (run: RunSummary) => {
    if (detailRun && detailRun.id === run.id) setDetailRun(null)
    try {
      await deleteRun(run.kind, run.id)
    } catch (e) {
      useSedimentStore.setState({ runsError: '删除失败：' + String(e) })
    }
  }

  const TabButton = ({ id, label }: { id: Tab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={[
        'px-3 py-1.5 text-[13px] rounded-lg transition-colors',
        tab === id ? 'bg-surface-2 text-ink' : 'text-ink-dim hover:text-ink-muted',
      ].join(' ')}
    >
      {label}
    </button>
  )

  const kindFilters: { id: FilterKind; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'board', label: '看板' },
    { id: 'workbench', label: '工作台' },
  ]

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold text-gradient mr-2">沉淀</h1>
          <TabButton id="runs" label="运行历史" />
          <TabButton id="skills" label="技能库" />
        </div>
        <p className="text-[11px] text-ink-dim mt-1">
          你过去让 AI 做过什么、用了哪些技能——可回顾、可检索、可复用的本地资产库。
        </p>
      </header>

      {tab === 'runs' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-2.5 border-b border-line flex items-center gap-2 flex-shrink-0">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadRuns()
              }}
              placeholder="搜索标题 / 目录 / 模型，回车检索"
              className="flex-1 max-w-md bg-surface border border-line rounded-lg px-3 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-emerald-600 transition-colors"
            />
            <button
              onClick={() => void loadRuns()}
              className="text-[12px] px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated border border-line text-ink-muted transition-colors"
            >
              搜索
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              {kindFilters.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilterKind(f.id)}
                  className={[
                    'text-[11px] px-2.5 py-1.5 rounded-lg transition-colors',
                    filterKind === f.id
                      ? 'bg-emerald-600/80 text-white'
                      : 'bg-surface border border-line text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {runsError && <div className="mb-3 text-[12px] text-red-600">{runsError}</div>}
            {runsLoading && runs.length === 0 ? (
              <div className="text-[12px] text-ink-dim">加载中…</div>
            ) : runs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-20">
                <Mascot mood="idle" size={80} className="mb-4" />
                <p className="text-ink-muted text-sm">还没有可沉淀的运行记录</p>
                <p className="text-ink-dim text-xs mt-1">
                  去「工作台」或「看板」跑一轮，运行历史会自动出现在这里。
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-w-6xl">
                {runs.map((run) => (
                  <RunCard
                    key={run.kind + ':' + run.id}
                    run={run}
                    onOpen={() => void openDetail(run)}
                    onReuse={() => void doReuse(run)}
                    onDelete={() => void doDelete(run)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {skillsError && <div className="mb-3 text-[12px] text-red-600">{skillsError}</div>}
          {skillsLoading && skills.length === 0 ? (
            <div className="text-[12px] text-ink-dim">扫描中…</div>
          ) : skills.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-20">
              <Mascot mood="thinking" size={80} className="mb-4" />
              <p className="text-ink-muted text-sm">没有发现本地技能</p>
              <p className="text-ink-dim text-xs mt-1 max-w-sm leading-5">
                在 pi(~/.pi/agent/skills)或 codex(~/.codex/skills)的技能目录下
                放入含 SKILL.md 的技能，它们会出现在这里。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-w-6xl">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.source + ':' + skill.path}
                  skill={skill}
                  onUse={() => navigate('/workbench')}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {detailRun && (
        <DetailOverlay
          run={detailRun}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => setDetailRun(null)}
          onReuse={() => void doReuse(detailRun)}
        />
      )}
    </div>
  )
}
