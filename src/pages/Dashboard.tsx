import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mascot } from '../components/ui'

// ── Tauri helper（与 sedimentStore 相同的按需加载模式） ─────────────────────────

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

// ── Types（对应 Rust stats.rs / sediment.rs） ──────────────────────────────────

interface StatsOverview {
  total_runs: number
  board_tasks: number
  workbench_sessions: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  active_days: number
  avg_tokens_per_run: number
}

interface TokenSeriesPoint {
  date: string // YYYY-MM-DD（本地时区）
  input: number
  output: number
  total: number
  runs: number
}

interface ModelStat {
  model: string
  runs: number
  input: number
  output: number
  total: number
}

interface RecentRun {
  id: string
  kind: 'board' | 'workbench'
  title: string
  cwd: string
  model?: string
  total_tokens?: number
  files_changed: number
  duration_ms?: number
  status: string
  created_at: number
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

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

/** 本地日历日 YYYY-MM-DD（与后端 SQLite 'localtime' 口径一致）。 */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  ended: '已结束',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  awaiting_review: '待确认',
  todo: '待办',
  queued: '排队中',
}

function statusClass(s: string): string {
  if (s === 'failed') return 'bg-red-100 text-red-600'
  if (s === 'running' || s === 'active') return 'bg-blue-100 text-blue-600'
  if (s === 'awaiting_review') return 'bg-amber-100 text-amber-600'
  return 'bg-elevated/60 text-ink-muted'
}

// ── KPI card ───────────────────────────────────────────────────────────────────

function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: string
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="glass rounded-card px-4 py-3.5 flex items-start gap-3">
      <div className="w-9 h-9 rounded-lg bg-primary-tint text-primary flex items-center justify-center text-lg flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-ink-dim">{label}</div>
        <div className="text-[22px] leading-7 font-bold text-ink tabular-nums truncate">
          {value}
        </div>
        {sub && (
          <div className="text-[10.5px] text-ink-muted tabular-nums truncate">{sub}</div>
        )}
      </div>
    </div>
  )
}

// ── Token 趋势图（纯 CSS 堆叠柱状图，不引第三方图表库） ─────────────────────────

function TrendChart({ series }: { series: TokenSeriesPoint[] }) {
  // 最近 30 个自然日窗口（含今天）；窗口内完全无数据时回退为最近 30 个有数据的桶。
  const points = useMemo(() => {
    const map = new Map(series.map((p) => [p.date, p]))
    const days: TokenSeriesPoint[] = []
    for (let i = 29; i >= 0; i--) {
      const key = localDay(new Date(Date.now() - i * 86_400_000))
      days.push(map.get(key) ?? { date: key, input: 0, output: 0, total: 0, runs: 0 })
    }
    const hasData = days.some((p) => p.total > 0 || p.runs > 0)
    return hasData ? days : series.slice(-30)
  }, [series])

  const maxTotal = Math.max(1, ...points.map((p) => p.total))

  return (
    <div>
      <div className="h-44 flex items-end gap-[3px]">
        {points.map((p) => {
          const cache = Math.max(0, p.total - p.input - p.output)
          const pct = (n: number) => (n / maxTotal) * 100
          return (
            <div
              key={p.date}
              className="group relative flex-1 h-full flex flex-col justify-end min-w-0"
            >
              {/* hover 提示 */}
              <div
                className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-20
                           bg-ink text-white text-[10.5px] leading-4 rounded-md px-2.5 py-1.5 whitespace-nowrap shadow-lg pointer-events-none"
              >
                <div className="font-medium">{p.date}</div>
                <div className="tabular-nums">
                  合计 {fmtTokens(p.total)} · 运行 {p.runs} 次
                </div>
                <div className="tabular-nums text-white/80">
                  输入 {fmtTokens(p.input)} · 输出 {fmtTokens(p.output)}
                  {cache > 0 && <> · 缓存 {fmtTokens(cache)}</>}
                </div>
              </div>
              {/* 柱体：输入(浅蓝) + 输出(深蓝) + 缓存等(极浅蓝)，自下而上 */}
              <div
                className="w-full flex flex-col-reverse rounded-t-[3px] overflow-hidden
                           group-hover:opacity-80 transition-opacity"
                style={{ height: `${Math.min(100, pct(p.total))}%` }}
              >
                <div className="w-full bg-blue-400" style={{ flexGrow: p.input }} />
                <div className="w-full bg-blue-600" style={{ flexGrow: p.output }} />
                <div className="w-full bg-blue-200" style={{ flexGrow: cache }} />
              </div>
              {/* 无数据日的基线刻度 */}
              {p.total === 0 && <div className="w-full h-[2px] bg-line rounded-full" />}
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-ink-dim tabular-nums">
        <span>{points[0]?.date ?? ''}</span>
        <span>{points[Math.floor(points.length / 2)]?.date ?? ''}</span>
        <span>{points[points.length - 1]?.date ?? ''}</span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[10.5px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <i className="w-2.5 h-2.5 rounded-sm bg-blue-400 inline-block" />输入
        </span>
        <span className="flex items-center gap-1.5">
          <i className="w-2.5 h-2.5 rounded-sm bg-blue-600 inline-block" />输出
        </span>
        <span className="flex items-center gap-1.5">
          <i className="w-2.5 h-2.5 rounded-sm bg-blue-200 inline-block" />缓存等
        </span>
      </div>
    </div>
  )
}

// ── 按模型占比（纯 CSS 横向条形） ───────────────────────────────────────────────

function ModelBars({ models }: { models: ModelStat[] }) {
  const totalSum = models.reduce((s, m) => s + m.total, 0)
  const maxRef = totalSum > 0
    ? Math.max(...models.map((m) => m.total))
    : Math.max(1, ...models.map((m) => m.runs))

  if (models.length === 0) {
    return <div className="text-[12px] text-ink-dim">暂无模型使用记录</div>
  }
  return (
    <div className="space-y-2.5">
      {models.map((m) => {
        const value = totalSum > 0 ? m.total : m.runs
        const widthPct = Math.max(2, (value / maxRef) * 100)
        const sharePct = totalSum > 0 ? ((m.total / totalSum) * 100).toFixed(1) : null
        return (
          <div key={m.model || '(空)'}>
            <div className="flex items-baseline gap-2 text-[11.5px] mb-1">
              <span className="font-mono text-ink truncate">
                {m.model || '未记录模型'}
              </span>
              <span className="text-ink-dim tabular-nums flex-shrink-0">
                {m.runs} 次
              </span>
              <span className="ml-auto text-ink-muted font-mono tabular-nums flex-shrink-0">
                {fmtTokens(m.total)}
                {sharePct != null && (
                  <span className="text-ink-dim"> · {sharePct}%</span>
                )}
              </span>
            </div>
            <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-600"
                style={{ width: `${widthPct}%` }}
                title={`输入 ${fmtTokens(m.input)} · 输出 ${fmtTokens(m.output)}`}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 最近运行表格 ────────────────────────────────────────────────────────────────

function RecentRunsTable({ runs }: { runs: RecentRun[] }) {
  if (runs.length === 0) {
    return <div className="text-[12px] text-ink-dim">暂无运行记录</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] text-ink-dim border-b border-line">
            <th className="py-2 pr-3 font-medium">标题</th>
            <th className="py-2 pr-3 font-medium">类型</th>
            <th className="py-2 pr-3 font-medium">模型</th>
            <th className="py-2 pr-3 font-medium text-right">Token</th>
            <th className="py-2 pr-3 font-medium text-right">时长</th>
            <th className="py-2 pr-3 font-medium">状态</th>
            <th className="py-2 font-medium text-right">时间</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.kind + ':' + r.id}
              className="border-b border-line/60 last:border-0 hover:bg-surface/60 transition-colors"
            >
              <td className="py-2 pr-3 max-w-[260px]">
                <span className="text-ink line-clamp-1 break-all" title={r.title}>
                  {r.title || '未命名运行'}
                </span>
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <span
                  className={[
                    'text-[10px] px-1.5 py-0.5 rounded font-medium',
                    r.kind === 'board'
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'bg-emerald-100 text-emerald-700',
                  ].join(' ')}
                >
                  {r.kind === 'board' ? '看板' : '工作台'}
                </span>
              </td>
              <td className="py-2 pr-3 font-mono text-ink-muted whitespace-nowrap">
                {r.model || '—'}
              </td>
              <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                {r.total_tokens != null ? fmtTokens(r.total_tokens) : '—'}
              </td>
              <td className="py-2 pr-3 tabular-nums text-right text-ink-muted whitespace-nowrap">
                {r.duration_ms != null ? fmtDuration(r.duration_ms) : '—'}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <span className={'text-[10px] px-1.5 py-0.5 rounded ' + statusClass(r.status)}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
              </td>
              <td className="py-2 tabular-nums text-right text-ink-dim whitespace-nowrap">
                {fmtDate(r.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── 主页面 ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<StatsOverview | null>(null)
  const [series, setSeries] = useState<TokenSeriesPoint[]>([])
  const [models, setModels] = useState<ModelStat[]>([])
  const [recent, setRecent] = useState<RecentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!isTauri) {
        setLoading(false)
        return
      }
      try {
        const [ov, se, mo, re] = await Promise.all([
          tauriInvoke<StatsOverview>('stats_overview'),
          tauriInvoke<TokenSeriesPoint[]>('stats_token_series', { bucket: 'day' }),
          tauriInvoke<ModelStat[]>('stats_by_model'),
          tauriInvoke<RecentRun[]>('stats_recent_runs', { limit: 10 }),
        ])
        if (cancelled) return
        setOverview(ov)
        setSeries(se)
        setModels(mo)
        setRecent(re)
      } catch (e) {
        if (!cancelled) setError('统计数据加载失败：' + String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // 本周（近 7 个自然日，含今天）token 合计——由日序列在前端汇总。
  const weekTokens = useMemo(() => {
    const from = localDay(new Date(Date.now() - 6 * 86_400_000))
    return series.filter((p) => p.date >= from).reduce((s, p) => s + p.total, 0)
  }, [series])

  const empty = !loading && !error && (overview == null || overview.total_runs === 0)

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <h1 className="text-base font-bold text-gradient">概览</h1>
        <p className="text-[11px] text-ink-dim mt-1">
          Agent 的运行次数与 token 消耗——看板任务和工作台会话的整体视图。
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && <div className="text-[12px] text-ink-dim">加载中…</div>}
        {error && <div className="mb-3 text-[12px] text-red-600">{error}</div>}

        {empty && (
          <div className="h-full flex flex-col items-center justify-center text-center py-20">
            <Mascot mood="idle" size={80} className="mb-4" />
            <p className="text-ink-muted text-sm">还没有运行记录</p>
            <p className="text-ink-dim text-xs mt-1">
              去「工作台」跑一轮任务，运行与 token 统计会自动出现在这里。
            </p>
            <button
              onClick={() => navigate('/workbench')}
              className="mt-4 text-[12px] px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white transition-colors"
            >
              打开工作台
            </button>
          </div>
        )}

        {!loading && !empty && overview && (
          <div className="max-w-6xl space-y-4">
            {/* KPI 卡片行 */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <KpiCard
                icon="🚀"
                label="总运行"
                value={String(overview.total_runs)}
                sub={`看板 ${overview.board_tasks} · 工作台 ${overview.workbench_sessions}`}
              />
              <KpiCard
                icon="🪙"
                label="总 Token"
                value={fmtTokens(overview.total_tokens)}
                sub={`输入 ${fmtTokens(overview.input_tokens)} · 输出 ${fmtTokens(overview.output_tokens)}`}
              />
              <KpiCard
                icon="📅"
                label="本周 Token"
                value={fmtTokens(weekTokens)}
                sub="近 7 天合计"
              />
              <KpiCard
                icon="🔥"
                label="活跃天数"
                value={String(overview.active_days)}
                sub={`平均每次 ${fmtTokens(overview.avg_tokens_per_run)} tokens`}
              />
            </div>

            {/* 趋势图 + 模型占比 */}
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-3">
              <section className="glass rounded-card p-4 xl:col-span-3">
                <h2 className="text-[13px] font-semibold text-ink mb-3">
                  Token 消耗趋势（按天）
                </h2>
                {series.length === 0 ? (
                  <div className="text-[12px] text-ink-dim">
                    还没有 token 消耗记录（工作台运行后自动统计）
                  </div>
                ) : (
                  <TrendChart series={series} />
                )}
              </section>
              <section className="glass rounded-card p-4 xl:col-span-2">
                <h2 className="text-[13px] font-semibold text-ink mb-3">按模型占比</h2>
                <ModelBars models={models} />
              </section>
            </div>

            {/* 最近运行 */}
            <section className="glass rounded-card p-4">
              <div className="flex items-center mb-3">
                <h2 className="text-[13px] font-semibold text-ink">最近运行</h2>
                <button
                  onClick={() => navigate('/sediment')}
                  className="ml-auto text-[11px] text-primary hover:text-primary-hover transition-colors"
                >
                  查看全部 →
                </button>
              </div>
              <RecentRunsTable runs={recent} />
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
