// 用量统计 — pi_usage 持久统计（SQLite 本地落库，重启不清零）。
// 数据源：pi_usage_overview / pi_usage_series / pi_usage_by_model / pi_usage_recent；
// 后端每写入一行会 emit 'pi-usage-updated'，本页监听后自动刷新（300ms 合并）。
// 旧 workbench（stats_*）统计区块与「内存/清零」的会话表已移除。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  KpiCard,
  TrendChart,
  ModelBars,
  PiUsageRecentTable,
  fmtCost,
  fmtTokens,
  localDay,
} from '../components/usage'
import type {
  PiUsageOverview,
  PiUsageDay,
  PiUsageModel,
  PiUsageRecord,
  TokenSeriesPoint,
  ModelStat,
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
  const [overview, setOverview] = useState<PiUsageOverview | null>(null)
  const [series, setSeries] = useState<PiUsageDay[]>([])
  const [models, setModels] = useState<PiUsageModel[]>([])
  const [recent, setRecent] = useState<PiUsageRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isTauri) {
      setLoading(false)
      return
    }
    try {
      const [ov, se, mo, re] = await Promise.all([
        tauriInvoke<PiUsageOverview>('pi_usage_overview'),
        tauriInvoke<PiUsageDay[]>('pi_usage_series', { days: 30 }),
        tauriInvoke<PiUsageModel[]>('pi_usage_by_model'),
        tauriInvoke<PiUsageRecord[]>('pi_usage_recent', { limit: 20 }),
      ])
      setOverview(ov)
      setSeries(se)
      setModels(mo)
      setRecent(re)
      setError(null)
    } catch (e) {
      setError('用量数据加载失败：' + String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次加载 + 'pi-usage-updated' 实时刷新（300ms 合并连续事件）。
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let timer: number | null = null
    let disposed = false
    void load()
    if (isTauri) {
      void (async () => {
        try {
          const { listen } = await import('@tauri-apps/api/event')
          const un = await listen('pi-usage-updated', () => {
            if (timer != null) return
            timer = window.setTimeout(() => {
              timer = null
              void load()
            }, 300)
          })
          if (disposed) un()
          else unlisten = un
        } catch (e) {
          console.warn('[Usage] pi-usage-updated 监听注册失败:', e)
        }
      })()
    }
    return () => {
      disposed = true
      if (unlisten) unlisten()
      if (timer != null) clearTimeout(timer)
    }
  }, [load])

  // 复用现有图表组件：pi 日序列/模型聚合 → 组件入参形状。
  const trendSeries = useMemo<TokenSeriesPoint[]>(
    () =>
      series.map((p) => ({
        date: p.day,
        input: p.input,
        output: p.output,
        total: p.input + p.output,
        runs: p.rows,
      })),
    [series],
  )
  const modelStats = useMemo<ModelStat[]>(
    () =>
      models.map((m) => ({
        model: m.model,
        runs: m.rows,
        input: m.input,
        output: m.output,
        total: m.input + m.output,
      })),
    [models],
  )

  // 本周（近 7 个自然日，含今天）token 合计——由日序列在前端汇总。
  const weekTokens = useMemo(() => {
    const from = localDay(new Date(Date.now() - 6 * 86_400_000))
    return series
      .filter((p) => p.day >= from)
      .reduce((s, p) => s + p.input + p.output, 0)
  }, [series])

  const empty = !loading && !error && (overview == null || overview.rows === 0)

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <h1 className="text-base font-bold text-gradient">用量统计</h1>
        <p className="text-[11px] text-ink-dim mt-1">
          会话的 token 与费用统计——数据本地持久存储（SQLite），重启不清零，会话进行中实时更新。
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error && <div className="mb-3 text-[12px] text-failed">{error}</div>}

        <div className="max-w-6xl space-y-4">
          {loading && <div className="text-[12px] text-ink-dim">用量统计加载中…</div>}

          {!isTauri && !loading && (
            <div className="glass rounded-card p-4 text-[12px] text-ink-dim">
              浏览器预览模式下无法连接本地统计数据库，用量统计仅在桌面应用内可见。
            </div>
          )}

          {empty && isTauri && (
            <div className="glass rounded-card px-6 py-10 text-center">
              <p className="text-ink-muted text-sm">还没有用量记录</p>
              <p className="text-ink-dim text-xs mt-1.5 max-w-md mx-auto leading-5">
                在「会话」页开始对话后，每轮回复的 token 与费用会自动落库，并在这里实时汇总。
              </p>
            </div>
          )}

          {!loading && !empty && overview && (
            <>
              {/* KPI 卡片行 */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                <KpiCard
                  icon="🪙"
                  label="总 Token"
                  value={fmtTokens(overview.total_input + overview.total_output)}
                  sub={`输入 ${fmtTokens(overview.total_input)} · 输出 ${fmtTokens(overview.total_output)}`}
                />
                <KpiCard
                  icon="💰"
                  label="总费用"
                  value={fmtCost(overview.total_cost)}
                  sub="按模型上报成本累计"
                />
                <KpiCard
                  icon="📅"
                  label="本周 Token"
                  value={fmtTokens(weekTokens)}
                  sub="近 7 天合计"
                />
                <KpiCard
                  icon="🗂️"
                  label="会话数"
                  value={String(overview.sessions)}
                  sub={`累计 ${overview.rows} 轮 · 缓存读 ${fmtTokens(overview.total_cache_read)}`}
                />
              </div>

              {/* 趋势图 + 模型占比 */}
              <div className="grid grid-cols-1 xl:grid-cols-5 gap-3">
                <section className="glass rounded-card p-4 xl:col-span-3">
                  <h2 className="text-[13px] font-semibold text-ink mb-3">
                    Token 消耗趋势（按天，近 30 天）
                  </h2>
                  {trendSeries.length === 0 ? (
                    <div className="text-[12px] text-ink-dim">
                      近 30 天还没有 token 消耗记录
                    </div>
                  ) : (
                    <TrendChart series={trendSeries} />
                  )}
                </section>
                <section className="glass rounded-card p-4 xl:col-span-2">
                  <h2 className="text-[13px] font-semibold text-ink mb-3">
                    按模型占比
                  </h2>
                  <ModelBars models={modelStats} />
                </section>
              </div>

              {/* 最近记录 */}
              <section className="glass rounded-card p-4">
                <h2 className="text-[13px] font-semibold text-ink mb-3">最近记录</h2>
                <PiUsageRecentTable records={recent} />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
