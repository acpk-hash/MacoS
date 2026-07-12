// 「在编码中重跑」弹窗：勾选要拼接的轮次（默认仅首轮）→ 跳转编码页并
// 预填 Composer（经 piStore.pendingComposerText 轻量字段，消费后即清空）。
// 目标 cwd 默认沿用原会话目录（setCwd），编码页据此新建会话。
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { WorkflowRecord } from '../../stores/agentHubStore'
import { usePiStore } from '../../stores/piStore'
import { copyText } from './workflowUtils'

export default function RerunDialog({
  rec,
  onClose,
}: {
  rec: WorkflowRecord
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [checked, setChecked] = useState<boolean[]>(() =>
    rec.fullPromptChain.map((_, i) => i === 0),
  )
  const [copied, setCopied] = useState(false)

  const selectedText = rec.fullPromptChain
    .filter((_, i) => checked[i])
    .join('\n\n')

  const toggle = (i: number) =>
    setChecked((prev) => prev.map((v, j) => (j === i ? !v : v)))

  const doCopy = async () => {
    if (!selectedText) return
    if (await copyText(selectedText)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  const doRerun = () => {
    if (!selectedText) return
    const pi = usePiStore.getState()
    if (rec.cwd) pi.setCwd(rec.cwd)
    pi.setPendingComposerText(selectedText)
    onClose()
    navigate('/')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-card border border-line bg-editor shadow-pop">
        <div className="flex-shrink-0 flex items-center px-4 h-11 border-b border-line">
          <span className="flex-1 text-[12.5px] font-medium text-ink">在编码中重跑</span>
          <button onClick={onClose} className="text-ink-dim hover:text-ink px-1" title="关闭">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="text-[11px] text-ink-dim mb-2">
            勾选要拼接进输入框的轮次（默认仅首轮，按原顺序拼接）：
          </div>
          <div className="space-y-1.5">
            {rec.fullPromptChain.map((p, i) => (
              <label
                key={i}
                className="flex items-start gap-2 rounded-btn border border-line bg-surface px-2.5 py-2 cursor-pointer hover:bg-surface-2 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={checked[i] ?? false}
                  onChange={() => toggle(i)}
                  className="mt-0.5 accent-primary"
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-[10px] text-ink-faint">第 {i + 1} 轮</span>
                  <span className="block text-[11.5px] text-ink truncate" title={p}>
                    {p.replace(/\s+/g, ' ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-line px-4 py-3">
          <div className="text-[10.5px] text-ink-dim truncate" title={rec.cwd}>
            目标目录：<span className="font-mono text-ink-muted">{rec.cwd}</span>（沿用原会话目录）
          </div>
          <div className="mt-0.5 text-[10px] text-ink-faint">
            将跳转到编码页并预填输入框；若当前没有活动会话，新建会话后输入框会自动预填。
            若该目录已不存在，请先在编码页重新选择项目。
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-btn border border-line bg-surface hover:bg-surface-2 text-[11.5px] text-ink-muted hover:text-ink transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => void doCopy()}
              disabled={!selectedText}
              className="px-3 py-1.5 rounded-btn border border-line bg-surface hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none text-[11.5px] text-ink-muted hover:text-ink transition-colors"
            >
              {copied ? '已复制 ✓' : '复制所选'}
            </button>
            <button
              onClick={doRerun}
              disabled={!selectedText}
              className="px-3 py-1.5 rounded-btn bg-primary hover:bg-primary-hover disabled:opacity-30 disabled:pointer-events-none text-[11.5px] text-white transition-colors"
            >
              在编码中重跑
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
