import { Link } from 'react-router-dom'
import { useSyncStore } from '../stores/syncStore'

/* ── Mock data ──────────────────────────────────────────────────────────────── */

const modelUsage = [
  { name: 'gpt-5.5', pct: 45, tokens: 128_340, color: '#0d8de3' },
  { name: 'gpt-4o', pct: 30, tokens: 85_560, color: '#10a37f' },
  { name: 'claude-opus', pct: 25, tokens: 71_300, color: '#b7791f' },
]

const dailyUsage = [
  { date: '07-16', tokens: 42_800, cost: 1.28 },
  { date: '07-15', tokens: 38_200, cost: 1.15 },
  { date: '07-14', tokens: 51_600, cost: 1.55 },
  { date: '07-13', tokens: 29_400, cost: 0.88 },
  { date: '07-12', tokens: 44_100, cost: 1.32 },
  { date: '07-11', tokens: 36_700, cost: 1.10 },
  { date: '07-10', tokens: 42_050, cost: 1.26 },
]

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export default function Usage() {
  const chatSessions = useSyncStore((s) => s.chatSessions)

  const todayTokens = dailyUsage[0].tokens
  const monthTokens = dailyUsage.reduce((sum, d) => sum + d.tokens, 0)

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <Link to="/data" className="text-ink-muted active:text-ink" style={{ textDecoration: 'none' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
          <h1>用量统计</h1>
        </div>
      </div>

      <div className="page-body">
        {/* Summary cards */}
        <div className="flex gap-2.5 mb-5 animate-in">
          <div className="card flex-1 flex flex-col gap-1">
            <span className="text-[11px] text-ink-dim font-medium">今日 Token</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-ink">{fmtNum(todayTokens)}</span>
              <span className="text-[11px] text-mint font-semibold flex items-center gap-0.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
                12%
              </span>
            </div>
          </div>

          <div className="card flex-1 flex flex-col gap-1">
            <span className="text-[11px] text-ink-dim font-medium">本月 Token</span>
            <span className="text-xl font-bold text-ink">{fmtNum(monthTokens)}</span>
          </div>

          <div className="card flex-1 flex flex-col gap-1">
            <span className="text-[11px] text-ink-dim font-medium">总对话数</span>
            <span className="text-xl font-bold text-ink">{chatSessions.length}</span>
          </div>
        </div>

        {/* Model usage chart */}
        <div className="animate-in mb-5">
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2.5 px-1">
            模型用量分布
          </p>
          <div className="card flex flex-col gap-4">
            {modelUsage.map((m) => (
              <div key={m.name} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{m.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-muted font-mono">{fmtNum(m.tokens)}</span>
                    <span className="text-xs font-semibold text-ink-dim">{m.pct}%</span>
                  </div>
                </div>
                <div className="h-2.5 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${m.pct}%`, backgroundColor: m.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Daily usage list */}
        <div className="animate-in mb-5">
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2.5 px-1">
            每日用量 (近 7 天)
          </p>
          <div className="card flex flex-col divide-y divide-line-soft">
            {dailyUsage.map((d) => (
              <div key={d.date} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-ink-muted font-mono w-10">{d.date}</span>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-ink">{fmtNum(d.tokens)} tokens</span>
                    <span className="text-[11px] text-ink-dim">${d.cost.toFixed(2)}</span>
                  </div>
                </div>
                {/* Mini bar */}
                <div className="w-20 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-sky"
                    style={{ width: `${(d.tokens / 52_000) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Model breakdown */}
        <div className="animate-in">
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2.5 px-1">
            模型调用排行
          </p>
          <div className="flex flex-col gap-2">
            {[...modelUsage]
              .sort((a, b) => b.tokens - a.tokens)
              .map((m, i) => (
                <div key={m.name} className="card-flat flex items-center gap-3">
                  <span
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: m.color }}
                  >
                    {i + 1}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-ink">{m.name}</p>
                    <p className="text-[11px] text-ink-dim">{fmtNum(m.tokens)} tokens &middot; {m.pct}% 占比</p>
                  </div>
                  <div
                    className="w-2 h-8 rounded-full"
                    style={{ backgroundColor: m.color, opacity: 0.25 }}
                  />
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
