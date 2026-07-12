import { useEffect, useMemo, useRef, useState } from 'react'
import { useStudioStore, type AggModel } from '../../stores/studioStore'
import { useVideoStore } from '../../stores/videoStore'
import VideoUploader from './VideoUploader'
import TaskCard from './TaskCard'

// 视频处理面板（核心模式）：上传 + AI 指令 + 结果流。

const EXAMPLE_INSTRUCTIONS = [
  '为这段视频生成字幕 SRT 文件',
  '写一份视频内容摘要',
  '建议剪辑方案，标注关键时间点',
  '分析视频的画面构图和色彩风格',
]

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

interface Props {
  onToast: (msg: string) => void
}

export default function ProcessPanel({ onToast }: Props) {
  const { aggModels, modelsLoaded } = useStudioStore()
  const {
    video,
    tasks,
    procModel,
    procProviderId,
    setProcSel,
    sendInstruction,
  } = useVideoStore()

  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const chatModels = useMemo(
    () => aggModels.filter((m) => m.kind === 'chat'),
    [aggModels],
  )
  const modelGroups = useMemo(() => groupByProvider(chatModels), [chatModels])

  // 自动选择 chat 模型。
  useEffect(() => {
    if (chatModels.length === 0) return
    if (!procModel || !chatModels.some((m) => m.modelId === procModel)) {
      const preferred =
        chatModels.find((m) => m.modelId === 'gpt-5.5') ?? chatModels[0]
      setProcSel(preferred.providerId, preferred.modelId)
    }
  }, [chatModels, procModel, setProcSel])

  const noModels = modelsLoaded && chatModels.length === 0

  const handleSend = async () => {
    if (!instruction.trim() || !video || sending) return
    setSending(true)
    try {
      await sendInstruction(instruction.trim())
      setInstruction('')
    } catch (e) {
      onToast('发送失败：' + String(e))
    } finally {
      setSending(false)
    }
  }

  const selCls =
    'bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div className="flex flex-col gap-3">
      {/* 视频上传/预览 */}
      <VideoUploader onToast={onToast} />

      {/* 模型选择 */}
      <label className="flex items-center gap-2">
        <span className="w-8 text-[11px] text-ink-dim flex-shrink-0">模型</span>
        <select
          value={
            procProviderId && procModel
              ? `${procProviderId}|${procModel}`
              : ''
          }
          onChange={(e) => {
            const i = e.target.value.indexOf('|')
            if (i < 0) return
            setProcSel(e.target.value.slice(0, i), e.target.value.slice(i + 1))
          }}
          disabled={chatModels.length === 0}
          className={selCls + ' flex-1 min-w-0'}
          title="分析模型"
        >
          {chatModels.length === 0 && (
            <option value="">无可用模型</option>
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

      {/* 指令输入 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-ink-dim tracking-wide">
          分析指令
        </span>
        <textarea
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void handleSend()
            }
          }}
          rows={3}
          placeholder={
            !video
              ? '请先上传视频'
              : noModels
                ? '请先在设置中添加模型服务'
                : '输入处理指令，如"为视频生成字幕 SRT"，Ctrl+Enter 发送'
          }
          disabled={!video || noModels}
          className="w-full resize-y bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim leading-relaxed focus:outline-none focus:border-lavender transition-colors disabled:opacity-50"
        />
      </div>

      {/* 发送按钮 */}
      <button
        onClick={() => void handleSend()}
        disabled={!instruction.trim() || !video || sending || noModels}
        className="w-full py-2 rounded-lg text-sm font-medium bg-grad-primary text-white shadow-glow-primary hover:-translate-y-px disabled:opacity-40 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all"
      >
        {sending ? '发送中…' : '发送指令'}
      </button>

      {/* 快捷指令（仅在有视频、无任务时显示） */}
      {video && tasks.length === 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-[11px] text-ink-dim">快捷指令</span>
          {EXAMPLE_INSTRUCTIONS.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setInstruction(ex)
                inputRef.current?.focus()
              }}
              className="text-left px-3 py-2 rounded-lg bg-surface-2/60 border border-line hover:bg-elevated hover:border-line-strong text-xs text-ink-muted leading-relaxed transition-all"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* 任务列表 */}
      {tasks.length > 0 && (
        <div className="flex flex-col gap-2 pt-1">
          <span className="text-[11px] font-medium text-ink-dim tracking-wide">
            分析结果
          </span>
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  )
}
