// StatusDot — 语义状态点：实心圆（无光晕，科研风）。
// 映射：running->蓝, done->绿, awaiting->橙, failed->红, todo->灰。
export type StatusKind =
  | 'running'
  | 'done'
  | 'todo'
  | 'failed'
  | 'awaiting'
  | 'idle'

const map: Record<StatusKind, string> = {
  running: '#2563eb',
  done: '#16a34a',
  todo: '#64748b',
  failed: '#dc2626',
  awaiting: '#d97706',
  idle: '#94a3b8',
}

export interface StatusDotProps {
  status: StatusKind
  size?: number
  pulse?: boolean
  className?: string
}

export default function StatusDot({
  status,
  size = 8,
  pulse = false,
  className = '',
}: StatusDotProps) {
  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${pulse ? 'animate-pulse' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: map[status],
      }}
    />
  )
}
