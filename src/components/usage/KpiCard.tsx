// KPI 总览卡（自旧 Dashboard 恢复）。

export default function KpiCard({
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
