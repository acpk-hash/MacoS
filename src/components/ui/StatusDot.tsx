// StatusDot — 语义状态点：实心圆（无光晕，IDE 浅色语义色系）。
// 映射：running->蓝, done->绿, awaiting->黄, failed->红, todo->灰。
export type StatusKind =
  | 'running'
  | 'done'
  | 'todo'
  | 'failed'
  | 'awaiting'
  | 'idle'

const map: Record<StatusKind, string> = {
  running: '#0d8de3',
  done: '#10a37f',
  todo: '#8a8a85',
  failed: '#d0342c',
  awaiting: '#b7791f',
  idle: '#b3b3ad',
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
