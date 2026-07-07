import type { AggModel } from '../stores/studioStore'

// Delimiter encoding (providerId, modelId) into one <option value>. Provider ids
// are uuids or the literal "default" and never contain '|'; decoding splits on
// the FIRST '|' so a '|' inside a model id is still handled correctly.
const SEP = '|'

export interface ModelPickerValue {
  providerId: string
  modelId: string
}

/**
 * Grouped model dropdown shared by the chat top bar and the generation params.
 * Models are grouped by their owning provider (optgroup per provider label), so
 * the aggregated multi-provider list stays legible. Controlled component: the
 * selection is `{ providerId, modelId }`.
 */
export default function ModelPicker({
  models,
  value,
  onChange,
  className,
  title,
  placeholder,
  disabled,
  emptyLabel,
}: {
  models: AggModel[]
  value: ModelPickerValue | null
  onChange: (v: ModelPickerValue) => void
  className?: string
  title?: string
  placeholder?: string
  disabled?: boolean
  emptyLabel?: string
}) {
  // Group models by provider while preserving first-seen order.
  const groups: { id: string; label: string; items: AggModel[] }[] = []
  const indexById = new Map<string, number>()
  for (const m of models) {
    let gi = indexById.get(m.providerId)
    if (gi === undefined) {
      gi = groups.length
      indexById.set(m.providerId, gi)
      groups.push({ id: m.providerId, label: m.providerLabel, items: [] })
    }
    groups[gi].items.push(m)
  }

  const selected = value ? `${value.providerId}${SEP}${value.modelId}` : ''
  const known =
    !!value &&
    models.some(
      (m) => m.providerId === value.providerId && m.modelId === value.modelId,
    )

  return (
    <select
      value={selected}
      disabled={disabled}
      title={title}
      onChange={(e) => {
        const raw = e.target.value
        const idx = raw.indexOf(SEP)
        if (idx < 0) return
        onChange({
          providerId: raw.slice(0, idx),
          modelId: raw.slice(idx + 1),
        })
      }}
      className={className}
    >
      {models.length === 0 && (
        <option value="">{emptyLabel ?? placeholder ?? '加载中…'}</option>
      )}
      {/* Preserve an out-of-list selection (e.g. a model no longer offered). */}
      {value && !known && value.modelId && (
        <option value={selected}>{value.modelId}</option>
      )}
      {groups.map((g) => (
        <optgroup key={g.id} label={g.label}>
          {g.items.map((m) => (
            <option
              key={`${g.id}${SEP}${m.modelId}`}
              value={`${m.providerId}${SEP}${m.modelId}`}
            >
              {m.modelId}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
