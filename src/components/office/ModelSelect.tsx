// 模型下拉选择（办公三窗口共用的小控件，纯展示 + 回调）。
import type { AggModel } from '../../stores/studioStore'

export interface ModelSelectProps {
  models: AggModel[]
  modelId: string
  onChange: (providerId: string, modelId: string) => void
  disabled?: boolean
}

export default function ModelSelect({
  models,
  modelId,
  onChange,
  disabled,
}: ModelSelectProps) {
  if (models.length === 0) {
    return <span className="text-[11px] text-ink-dim">（无可用模型）</span>
  }
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
      模型
      <select
        value={modelId}
        disabled={disabled}
        onChange={(e) => {
          const m = models.find((x) => x.modelId === e.target.value)
          if (m) onChange(m.providerId, m.modelId)
        }}
        className="rounded-btn border border-line bg-surface-2 px-2 py-1 text-xs text-ink
                   focus:outline-none focus:border-primary disabled:opacity-50"
      >
        {models.map((m) => (
          <option key={`${m.providerId}/${m.modelId}`} value={m.modelId}>
            {m.modelId}
          </option>
        ))}
      </select>
    </label>
  )
}
