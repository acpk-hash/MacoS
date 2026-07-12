// 步骤态指示条：输入 → 处理中 → 结果（三窗口共用）。
export interface StageStepsProps {
  steps: string[]
  /** 当前进行到第几步（0 起）。 */
  current: number
}

export default function StageSteps({ steps, current }: StageStepsProps) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-dim">→</span>}
          <span
            className={`rounded-chip border px-2 py-0.5 ${
              i === current
                ? 'border-primary bg-primary-tint text-primary font-medium'
                : i < current
                  ? 'border-line bg-surface-2 text-ink-muted'
                  : 'border-line bg-transparent text-ink-dim'
            }`}
          >
            {i < current ? '✓ ' : ''}
            {s}
          </span>
        </div>
      ))}
    </div>
  )
}
