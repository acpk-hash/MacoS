// AgentHub 详情抽屉：步骤时间线（图标 + 摘要，user 全文可展开）、
// prompt 链完整展示（逐条复制）、复用（复制首轮 / 在编码中重跑）、导出 / 删除。
import { useState } from 'react'
import type { WorkflowRecord, WorkflowStep } from '../../stores/agentHubStore'
import { STATUS_META, copyText } from './workflowUtils'
import RerunDialog from './RerunDialog'

const KIND_META: Record<WorkflowStep['kind'], { label: string; dot: string }> = {
  user: { label: '用户', dot: 'bg-primary' },
  assistant: { label: '助手', dot: 'bg-done' },
  tool: { label: '工具', dot: 'bg-gold' },
}

function StepRow({ step, index }: { step: WorkflowStep; index: number }) {
  const [open, setOpen] = useState(false)
  const meta = KIND_META[step.kind]
  const oneLine = step.summary.replace(/\s+/g, ' ')
  const expandable =
    step.kind === 'user' && (step.summary.includes('\n') || oneLine.length > 100)
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-col items-center flex-shrink-0">
        <span className={`mt-1 w-2 h-2 rounded-full ${meta.dot}`} />
        <span className="flex-1 w-px bg-line-soft" />
      </div>
      <div className="flex-1 min-w-0 pb-3.5">
        <div className="text-[10px] text-ink-faint">
          #{index + 1} · {step.kind === 'tool' ? step.toolName ?? '工具' : meta.label}
        </div>
        {step.kind === 'tool' ? (
          <div
            className="mt-0.5 text-[11.5px] font-mono text-ink-muted break-all"
            title={step.cmd ?? step.path ?? undefined}
          >
            {step.summary}
          </div>
        ) : step.kind === 'user' ? (
          open ? (
            <div className="mt-0.5 text-[12px] text-ink whitespace-pre-wrap break-words">
              {step.summary}
            </div>
          ) : (
            <div className="mt-0.5 text-[12px] text-ink truncate">{oneLine}</div>
          )
        ) : (
          <div className="mt-0.5 text-[12px] text-ink-muted whitespace-pre-wrap break-words">
            {step.summary}
          </div>
        )}
        {expandable && (
          <button
            onClick={() => setOpen(!open)}
            className="mt-0.5 text-[10.5px] text-ink-dim hover:text-ink underline underline-offset-2"
          >
            {open ? '收起' : '展开全文'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function WorkflowDrawer({
  rec,
  onClose,
  onExport,
  onDelete,
}: {
  rec: WorkflowRecord
  onClose: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const [rerunOpen, setRerunOpen] = useState(false)
  /** 已复制反馈：-1=「复制首轮」按钮，>=0 为 prompt 链第 N 轮。 */
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const status = STATUS_META[rec.status]

  const copyPrompt = async (text: string, idx: number) => {
    if (!text) return
    if (!(await copyText(text))) return
    setCopiedIdx(idx)
    window.setTimeout(() => setCopiedIdx((v) => (v === idx ? null : v)), 1500)
  }

  return (
    <>
      <div className="fixed inset-0 z-40">
        <div className="absolute inset-0 bg-black/20" onClick={onClose} />
        <div className="absolute right-0 top-0 h-full w-[560px] max-w-[92vw] bg-editor border-l border-line shadow-pop flex flex-col">
          {/* 头部 */}
          <div className="flex-shrink-0 flex items-center gap-2 px-5 h-12 border-b border-line">
            <span
              className="flex-1 min-w-0 truncate text-[13px] font-medium text-ink"
              title={rec.title}
            >
              {rec.title}
            </span>
            <span
              className={`flex-shrink-0 px-1.5 py-0.5 rounded-chip border text-[10px] ${status.cls}`}
            >
              {status.label}
            </span>
            <button onClick={onClose} className="text-ink-dim hover:text-ink px-1" title="关闭">
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* 元信息 */}
            <div className="rounded-card border border-line bg-surface px-3.5 py-2.5 text-[11px] text-ink-muted space-y-1">
              <div>
                模型：<span className="font-mono">{rec.model || '（默认）'}</span>
              </div>
              <div className="truncate" title={rec.cwd}>
                目录：<span className="font-mono">{rec.cwd}</span>
              </div>
              <div>
                创建：{new Date(rec.createdAt).toLocaleString('zh-CN')} · 结束：
                {new Date(rec.finishedAt).toLocaleString('zh-CN')}
              </div>
              {rec.usage && (
                <div>
                  用量：输入 {rec.usage.input} / 输出 {rec.usage.output} tokens ·{' '}
                  {rec.usage.turns} 轮 · ${rec.usage.cost.toFixed(4)}
                </div>
              )}
            </div>

            {/* 复用 / 导出 / 删除 */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setRerunOpen(true)}
                disabled={rec.fullPromptChain.length === 0}
                className="px-3 py-1.5 rounded-btn bg-primary hover:bg-primary-hover disabled:opacity-30 disabled:pointer-events-none text-[11.5px] text-white transition-colors"
                title="复用此工作流：跳转编码页并预填输入框"
              >
                在编码中重跑
              </button>
              <button
                onClick={() => void copyPrompt(rec.fullPromptChain[0] ?? '', -1)}
                disabled={rec.fullPromptChain.length === 0}
                className="px-3 py-1.5 rounded-btn border border-line bg-surface hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none text-[11.5px] text-ink-muted hover:text-ink transition-colors"
                title="复用此工作流：把首轮 prompt 复制进剪贴板"
              >
                {copiedIdx === -1 ? '已复制 ✓' : '复制首轮 prompt'}
              </button>
              <div className="flex-1" />
              <button
                onClick={onExport}
                className="px-2.5 py-1.5 rounded-btn border border-line bg-surface hover:bg-surface-2 text-[11px] text-ink-muted hover:text-ink transition-colors"
                title="把工作流导出为 Markdown 文件"
              >
                导出 .md
              </button>
              <button
                onClick={onDelete}
                className="px-2.5 py-1.5 rounded-btn border border-line bg-surface text-[11px] text-ink-muted hover:text-coral hover:border-coral/30 transition-colors"
                title="删除此存档"
              >
                删除
              </button>
            </div>

            {/* 步骤时间线 */}
            <div className="mt-5">
              <div className="mb-2 text-[11px] font-medium text-ink-dim">
                步骤时间线（{rec.steps.length} 步）
              </div>
              <div>
                {rec.steps.map((s, i) => (
                  <StepRow key={i} step={s} index={i} />
                ))}
                {rec.steps.length === 0 && (
                  <div className="text-[11px] text-ink-faint">（无步骤）</div>
                )}
              </div>
            </div>

            {/* Prompt 链 */}
            <div className="mt-5">
              <div className="mb-2 text-[11px] font-medium text-ink-dim">
                Prompt 链（{rec.fullPromptChain.length} 轮）
              </div>
              <div className="space-y-2.5">
                {rec.fullPromptChain.map((p, i) => (
                  <div key={i} className="rounded-card border border-line bg-surface">
                    <div className="flex items-center px-3 pt-2">
                      <span className="flex-1 text-[10.5px] text-ink-faint">第 {i + 1} 轮</span>
                      <button
                        onClick={() => void copyPrompt(p, i)}
                        className="text-[10.5px] text-ink-dim hover:text-ink underline underline-offset-2"
                      >
                        {copiedIdx === i ? '已复制 ✓' : '复制'}
                      </button>
                    </div>
                    <pre className="px-3 pb-2.5 pt-1 text-[11.5px] text-ink whitespace-pre-wrap break-words font-sans">
                      {p}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {rerunOpen && <RerunDialog rec={rec} onClose={() => setRerunOpen(false)} />}
    </>
  )
}
