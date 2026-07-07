// Shared read-only execution-flow renderer (session -> steps), extracted from
// the Canvas page so both Canvas and the Sediment run-detail can reuse it.

import type { FlowSession, FlowStep, NodeStatus } from './types'

function statusDot(status: NodeStatus): string {
  if (status === 'running') return 'bg-blue-400 canvas-glow'
  if (status === 'failed') return 'bg-red-500'
  return 'bg-green-500'
}

function statusText(status: NodeStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  return '已完成'
}

function statusPill(status: NodeStatus): string {
  if (status === 'running') return 'bg-blue-600/30 text-blue-300'
  if (status === 'failed') return 'bg-red-600/30 text-red-300'
  return 'bg-green-600/30 text-green-300'
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return String(ms)
  }
}

const KIND_META: Record<FlowStep['stepKind'], { label: string; color: string }> = {
  reply: { label: '回复', color: 'text-sky-300' },
  command: { label: '命令', color: 'text-emerald-300' },
  file: { label: '文件', color: 'text-purple-300' },
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
        className={`w-full text-left rounded-lg border bg-gray-900 hover:bg-gray-800/70 transition-colors px-3 py-2 ${
          step.status === 'failed' ? 'border-red-600/50' : 'border-gray-800'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold ${meta.color}`}>{meta.label}</span>
          {step.stepKind === 'command' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                step.exitCode === 0
                  ? 'bg-green-600/30 text-green-300'
                  : 'bg-red-600/30 text-red-300'
              }`}
            >
              exit {step.exitCode}
            </span>
          )}
          {step.stepKind === 'file' && (
            <span className="text-[10px] font-mono">
              <span className="text-green-400">+{step.added ?? 0}</span>{' '}
              <span className="text-red-400">-{step.removed ?? 0}</span>
            </span>
          )}
          <span className="ml-auto text-[10px] text-gray-600">{fmtTime(step.ts)}</span>
        </div>

        <div className="mt-1 text-[12px] text-gray-300">
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
            <code className="block font-mono break-all line-clamp-1 text-gray-400">
              {step.path}
            </code>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-1 mb-2 rounded-lg border border-gray-800 bg-gray-950 p-3 text-[12px] text-gray-300 space-y-2">
          {step.stepKind === 'reply' && (
            <pre className="whitespace-pre-wrap break-words leading-relaxed">
              {step.text || '（空回复）'}
            </pre>
          )}
          {step.stepKind === 'command' && (
            <>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">命令</div>
                <pre className="font-mono whitespace-pre-wrap break-all bg-gray-900 rounded p-2">
                  {step.cmd}
                </pre>
              </div>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">输出（末尾）</div>
                <pre className="font-mono whitespace-pre-wrap break-all bg-gray-900 rounded p-2 max-h-72 overflow-auto text-gray-400 text-[11px]">
                  {step.outputTail || '（无输出）'}
                </pre>
              </div>
            </>
          )}
          {step.stepKind === 'file' && (
            <>
              <div className="font-mono break-all text-gray-200">{step.path}</div>
              <div className="text-[11px] text-gray-500">变更类型：{step.changeKind}</div>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">差异</div>
                <pre className="font-mono whitespace-pre bg-gray-900 rounded p-2 max-h-96 overflow-auto text-[11px]">
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
    <div className="border border-gray-800 rounded-xl bg-gray-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900/60">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(sess.status)}`} />
        <span className="text-[12px] font-semibold text-gray-200">
          会话 #{sess.index + 1}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/30 text-indigo-300 font-mono">
          {sess.engine}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusPill(sess.status)}`}>
          {statusText(sess.status)}
        </span>
        <span className="ml-auto text-[11px] text-gray-500">{sess.stepCount} 步</span>
      </div>

      {sess.status === 'failed' && sess.errorText && (
        <div className="px-3 py-2 text-[11px] text-red-400 whitespace-pre-wrap break-all border-b border-gray-800">
          {sess.errorText}
        </div>
      )}

      <div className="p-3 space-y-1.5">
        {sess.steps.length === 0 ? (
          <div className="text-[11px] text-gray-600 pl-6">暂无步骤</div>
        ) : (
          <div className="relative">
            <span className="absolute left-[10px] top-2 bottom-2 w-px bg-gray-800" />
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
