import { useEffect, useMemo } from 'react'
import { useStudioStore, type AggModel } from '../../stores/studioStore'
import { useVideoStore } from '../../stores/videoStore'

// 视频生成面板：prompt + 模型选择 + 生成按钮。
// 模型列表从 aggModels 过滤 kind==='video'；列表为空时提示用户到设置添加。

function groupByProvider(
  models: AggModel[],
): { providerId: string; providerLabel: string; items: AggModel[] }[] {
  const groups: { providerId: string; providerLabel: string; items: AggModel[] }[] = []
  for (const m of models) {
    const g = groups.find((x) => x.providerId === m.providerId)
    if (g) g.items.push(m)
    else
      groups.push({
        providerId: m.providerId,
        providerLabel: m.providerLabel,
        items: [m],
      })
  }
  return groups
}

export default function GeneratePanel() {
  const { aggModels, modelsLoaded } = useStudioStore()
  const { genPrompt, setGenPrompt, genModel, genProviderId, setGenSel } =
    useVideoStore()

  const videoModels = useMemo(
    () => aggModels.filter((m) => m.kind === 'video'),
    [aggModels],
  )
  const modelGroups = useMemo(() => groupByProvider(videoModels), [videoModels])

  // 模型列表就绪后保持选中项有效。
  useEffect(() => {
    if (videoModels.length === 0) return
    if (!genModel || !videoModels.some((m) => m.modelId === genModel)) {
      setGenSel(videoModels[0].providerId, videoModels[0].modelId)
    }
  }, [videoModels, genModel, setGenSel])

  const noModels = modelsLoaded && videoModels.length === 0

  const selCls =
    'bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div className="flex flex-col gap-3">
      {/* Prompt */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-ink-dim tracking-wide">
          描述
        </span>
        <textarea
          value={genPrompt}
          onChange={(e) => setGenPrompt(e.target.value)}
          rows={5}
          placeholder={
            noModels
              ? '请在设置中添加支持视频生成的服务商（如 Sora）'
              : '描述你想生成的视频内容'
          }
          disabled={noModels}
          className="w-full resize-y bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim leading-relaxed focus:outline-none focus:border-lavender transition-colors disabled:opacity-50"
        />
      </div>

      {/* Model selector */}
      <label className="flex items-center gap-2">
        <span className="w-8 text-[11px] text-ink-dim flex-shrink-0">模型</span>
        <select
          value={
            genProviderId && genModel ? `${genProviderId}|${genModel}` : ''
          }
          onChange={(e) => {
            const i = e.target.value.indexOf('|')
            if (i < 0) return
            setGenSel(e.target.value.slice(0, i), e.target.value.slice(i + 1))
          }}
          disabled={videoModels.length === 0}
          className={selCls + ' flex-1 min-w-0'}
          title="视频模型"
        >
          {videoModels.length === 0 && (
            <option value="">无可用视频模型</option>
          )}
          {modelGroups.map((g) => (
            <optgroup key={g.providerId} label={g.providerLabel}>
              {g.items.map((m) => (
                <option
                  key={m.modelId}
                  value={`${m.providerId}|${m.modelId}`}
                >
                  {m.modelId}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {/* Generate button */}
      <button
        disabled={!genPrompt.trim() || noModels}
        className="w-full py-2 rounded-lg text-sm font-medium bg-grad-primary text-white shadow-glow-primary hover:-translate-y-px disabled:opacity-40 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all"
      >
        生成视频
      </button>
      <p className="text-[11px] text-ink-dim leading-relaxed">
        视频由 AI 生成，生成速度取决于模型与视频时长。
      </p>

      {noModels && (
        <div className="rounded-card border border-line bg-surface px-4 py-4">
          <p className="text-sm text-ink font-medium mb-1">
            没有可用的视频模型
          </p>
          <p className="text-xs text-ink-muted leading-relaxed">
            请在「设置」页面添加支持视频生成的服务商（如 OpenAI Sora），
            添加后此处将自动显示可用模型。
          </p>
        </div>
      )}
    </div>
  )
}
