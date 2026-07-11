// Shared read-only execution-flow renderer (session -> steps), extracted from
// the Canvas page so both Canvas and the Sediment run-detail can reuse it.

import type { FlowSession, FlowStep, NodeStatus } from './types'

function statusDot(status: NodeStatus): string {
  if (status === 'running') return 'bg-sky canvas-glow'
  if (status === 'failed') return 'bg-failed'
  return 'bg-done'
}

function statusText(status: NodeStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  return '已完成'
}

function statusPill(status: NodeStatus): string {
  if (status === 'running') return 'bg-primary-tint text-sky'
  if (status === 'failed') return 'bg-[#f851491f] text-failed'
  return 'bg-[#3fb9501f] text-done'
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return String(ms)
  }
}

const KIND_META: Record<FlowStep['stepKind'], { label: string; color: string }> = {
  reply: { label: '回复', color: 'text-running' },
  command: { label: '命令', color: 'text-done' },
  file: { label: '文件', color: 'text-primary' },
}

function StepCard({
  step,
  expanded,
  onToggle,
}: {
  step: FlowStep
  expanded: boolean
  onToggle: () => void
}) {
  const meta = KIND_META[step.stepKind]
  return (
    <div className="relative pl-6">
      <span
        className={`absolute left-[6px] top-3 w-2 h-2 rounded-full ${statusDot(
          step.status,
        )}`}
      />
      <button
        onClick={onToggle}
        className={`w-full text-left rounded-lg border bg-surface hover:bg-surface-2/70 transition-colors px-3 py-2 ${
          step.status === 'failed' ? 'border-[#f8514966]' : 'border-line'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold ${meta.color}`}>{meta.label}</span>
          {step.stepKind === 'command' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                step.exitCode === 0
                  ? 'bg-[#3fb9501f] text-done'
                  : 'bg-[#f851491f] text-failed'
              }`}
            >
              exit {step.exitCode}
            </span>
          )}
          {step.stepKind === 'file' && (
            <span className="text-[10px] font-mono">
              <span className="text-done">+{step.added ?? 0}</span>{' '}
              <span className="text-failed">-{step.removed ?? 0}</span>
            </span>
          )}
          <span className="ml-auto text-[10px] text-ink-dim">{fmtTime(step.ts)}</span>
        </div>

        <div className="mt-1 text-[12px] text-ink-muted">
          {step.stepKind === 'reply' && (
            <span className="line-clamp-2 whitespace-pre-wrap break-words">
              {step.text || '（空回复）'}
            </span>
          )}
          {step.stepKind === 'command' && (
            <code className="block font-mono break-all line-clamp-2">
              {step.cmd || '（空命令）'}
            </code>
          )}
          {step.stepKind === 'file' && (
            <code className="block font-mono break-all line-clamp-1 text-ink-muted">
              {step.path}
            </code>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-1 mb-2 rounded-lg border border-line bg-bg p-3 text-[12px] text-ink-muted space-y-2">
          {step.stepKind === 'reply' && (
            <pre className="whitespace-pre-wrap break-words leading-relaxed">
              {step.text || '（空回复）'}
            </pre>
          )}
          {step.stepKind === 'command' && (
            <>
              <div>
                <div className="text-[11px] text-ink-dim mb-1">命令</div>
                <pre className="font-mono whitespace-pre-wrap break-all bg-surface rounded p-2">
                  {step.cmd}
                </pre>
              </div>
              <div>
                <div className="text-[11px] text-ink-dim mb-1">输出（末尾）</div>
                <pre className="font-mono whitespace-pre-wrap break-all bg-surface rounded p-2 max-h-72 overflow-auto text-ink-muted text-[11px]">
                  {step.outputTail || '（无输出）'}
                </pre>
              </div>
            </>
          )}
          {step.stepKind === 'file' && (
            <>
              <div className="font-mono break-all text-ink">{step.path}</div>
              <div className="text-[11px] text-ink-dim">变更类型：{step.changeKind}</div>
              <div>
                <div className="text-[11px] text-ink-dim mb-1">差异</div>
                <pre className="font-mono whitespace-pre bg-surface rounded p-2 max-h-96 overflow-auto text-[11px]">
                  {step.diff || '（无差异内容）'}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function SessionBlock({
  sess,
  expanded,
  onToggleStep,
}: {
  sess: FlowSession
  expanded: Set<string>
  onToggleStep: (id: string) => void
}) {
  return (
    <div className="border border-line rounded-xl bg-surface/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-surface/60">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(sess.status)}`} />
        <span className="text-[12px] font-semibold text-ink">
          会话 #{sess.index + 1}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-tint text-primary font-mono">
          {sess.engine}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusPill(sess.status)}`}>
          {statusText(sess.status)}
        </span>
        <span className="ml-auto text-[11px] text-ink-dim">{sess.stepCount} 步</span>
      </div>

      {sess.status === 'failed' && sess.errorText && (
        <div className="px-3 py-2 text-[11px] text-failed whitespace-pre-wrap break-all border-b border-line">
          {sess.errorText}
        </div>
      )}

      <div className="p-3 space-y-1.5">
        {sess.steps.length === 0 ? (
          <div className="text-[11px] text-ink-dim pl-6">暂无步骤</div>
        ) : (
          <div className="relative">
            <span className="absolute left-[10px] top-2 bottom-2 w-px bg-surface-2" />
            <div className="space-y-1.5">
              {sess.steps.map((st) => (
                <StepCard
                  key={st.id}
                  step={st}
                  expanded={expanded.has(st.id)}
                  onToggle={() => onToggleStep(st.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
