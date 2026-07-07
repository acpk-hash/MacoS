// Memoized custom nodes for the workflow canvas.
// Every node is wrapped in React.memo — a single task can produce 100+ nodes.

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeStatus, SessionNodeData, StepNodeData, TaskNodeData } from './types'

// Border / glow classes keyed by lifecycle status.
function statusRing(status: NodeStatus): string {
  if (status === 'running') return 'border-blue-500 canvas-glow'
  if (status === 'failed') return 'border-red-500'
  return 'border-green-600'
}

const BASE =
  'rounded-lg border-2 bg-gray-900 text-gray-100 shadow-lg shadow-black/40 px-3 py-2'

const handleStyle = { width: 8, height: 8, background: '#475569', border: 'none' }

// Task status → Chinese badge label + color.
function taskBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case 'running':
      return { label: '运行中', cls: 'bg-blue-600/30 text-blue-300' }
    case 'awaiting_review':
      return { label: '待验收', cls: 'bg-amber-600/30 text-amber-300' }
    case 'done':
      return { label: '已完成', cls: 'bg-green-600/30 text-green-300' }
    case 'failed':
      return { label: '失败', cls: 'bg-red-600/30 text-red-300' }
    case 'todo':
      return { label: '待办', cls: 'bg-gray-600/30 text-gray-300' }
    default:
      return { label: status, cls: 'bg-gray-600/30 text-gray-300' }
  }
}

// ── TaskNode (root) ────────────────────────────────────────────────────────────

export const TaskNode = memo(function TaskNode({ data }: NodeProps) {
  const d = data as unknown as TaskNodeData
  const badge = taskBadge(d.status)
  return (
    <div className={`${BASE} w-[220px] border-blue-400/60`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-semibold text-blue-300 tracking-wide">任务</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
      </div>
      <div className="text-sm font-medium leading-snug line-clamp-2">{d.title || '未命名任务'}</div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  )
})

// ── SessionNode ────────────────────────────────────────────────────────────────

export const SessionNode = memo(function SessionNode({ data }: NodeProps) {
  const d = data as unknown as SessionNodeData
  return (
    <div className={`${BASE} w-[200px] ${statusRing(d.status)}`}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-semibold text-gray-400 tracking-wide">
          会话 #{d.index + 1}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/30 text-indigo-300 font-mono">
          {d.engine}
        </span>
      </div>
      <div className="text-[11px] text-gray-500 font-mono truncate" title={d.threadId ?? ''}>
        {d.threadId ? `线程 ${d.threadId.slice(0, 12)}…` : '未获取线程'}
      </div>
      <div className="text-[11px] text-gray-400 mt-1">{d.stepCount} 个步骤</div>
      {d.status === 'failed' && d.errorText && (
        <div className="text-[10px] text-red-400 mt-1 line-clamp-2">{d.errorText}</div>
      )}
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  )
})

// ── StepNode (reply / command / file) ──────────────────────────────────────────

export const StepNode = memo(function StepNode({ data }: NodeProps) {
  const d = data as unknown as StepNodeData
  return (
    <div className={`${BASE} w-[200px] ${statusRing(d.status)}`}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      {d.stepKind === 'reply' && (
        <>
          <div className="text-[10px] font-semibold text-sky-300 mb-1">回复</div>
          <div className="text-[11px] text-gray-300 leading-snug line-clamp-3 whitespace-pre-wrap">
            {d.text || '（空回复）'}
          </div>
        </>
      )}
      {d.stepKind === 'command' && (
        <>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold text-emerald-300">命令</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                d.exitCode === 0
                  ? 'bg-green-600/30 text-green-300'
                  : 'bg-red-600/30 text-red-300'
              }`}
            >
              exit {d.exitCode}
            </span>
          </div>
          <code className="block text-[11px] font-mono text-gray-300 break-all line-clamp-2">
            {d.cmd || '（空命令）'}
          </code>
        </>
      )}
      {d.stepKind === 'file' && (
        <>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold text-purple-300">文件</span>
            <span className="text-[10px] text-gray-500">{d.changeKind}</span>
          </div>
          <div className="text-[11px] font-mono text-gray-300 break-all line-clamp-2">
            {d.path}
          </div>
          <div className="text-[10px] mt-1 font-mono">
            <span className="text-green-400">+{d.added ?? 0}</span>{' '}
            <span className="text-red-400">-{d.removed ?? 0}</span>
          </div>
        </>
      )}
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  )
})
