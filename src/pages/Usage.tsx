// 用量板块 — token 消耗与运行统计展示台。
// 历史统计（stats_* 命令）自旧 Dashboard（698a026）恢复；当前 pi 会话用量为新增（只读 piStore）。

import { useEffect, useMemo, useState } from 'react'
import {
  KpiCard,
  TrendChart,
  ModelBars,
  RecentRunsTable,
  PiSessionUsageTable,
  fmtTokens,
  localDay,
} from '../components/usage'
import type {
  StatsOverview,
  TokenSeriesPoint,
  ModelStat,
  RecentRun,
} from '../components/usage'

// ── Tauri helper（按需加载，浏览器 dev 模式下跳过后端） ────────────────────────

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

// ── 主页面 ─────────────────────────────────────────────────────────────────────

export default function Usage() {
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

  const historyEmpty =
    !loading && !error && (overview == null || overview.total_runs === 0)

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <h1 className="text-base font-bold text-gradient">用量</h1>
        <p className="text-[11px] text-ink-dim mt-1">
          Token 消耗与运行统计——当前 pi 会话的实时用量 + 历史运行记录的整体视图。
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error && <div className="mb-3 text-[12px] text-failed">{error}</div>}

        <div className="max-w-6xl space-y-4">
          {/* 当前 pi 会话用量（内存态，新增） */}
          <section className="glass rounded-card p-4">
            <div className="flex items-baseline gap-2 mb-3">
              <h2 className="text-[13px] font-semibold text-ink">当前 pi 会话用量</h2>
              <span className="text-[10.5px] text-ink-dim">
                当前运行期（内存）数据，重启应用后清零
              </span>
            </div>
            <PiSessionUsageTable />
          </section>

          {/* 历史统计（后端 stats_* 聚合） */}
          {loading && <div className="text-[12px] text-ink-dim">历史统计加载中…</div>}

          {!isTauri && !loading && (
            <div className="glass rounded-card p-4 text-[12px] text-ink-dim">
              浏览器预览模式下无法连接本地统计数据库，历史统计仅在桌面应用内可见。
            </div>
          )}

          {historyEmpty && isTauri && (
            <div className="glass rounded-card px-6 py-10 text-center">
              <p className="text-ink-muted text-sm">暂无历史运行统计</p>
              <p className="text-ink-dim text-xs mt-1.5 max-w-md mx-auto leading-5">
                这里的历史统计来自 workbench 时代的运行记录；pi
                会话的实时计量在上方表格及各会话信息中查看。
              </p>
            </div>
          )}

          {!loading && !historyEmpty && overview && (
            <>
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
                      还没有 token 消耗记录
                    </div>
                  ) : (
                    <TrendChart series={series} />
                  )}
                </section>
                <section className="glass rounded-card p-4 xl:col-span-2">
                  <h2 className="text-[13px] font-semibold text-ink mb-3">
                    按模型占比
                  </h2>
                  <ModelBars models={models} />
                </section>
              </div>

              {/* 最近运行 */}
              <section className="glass rounded-card p-4">
                <h2 className="text-[13px] font-semibold text-ink mb-3">最近运行</h2>
                <RecentRunsTable runs={recent} />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
