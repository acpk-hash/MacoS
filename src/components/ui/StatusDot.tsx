// StatusDot — 语义状态点：实心圆 + 同色低透光晕。
// 映射：running→sky, done→mint, todo→lavender, failed→coral, awaiting→gold。
export type StatusKind =
  | 'running'
  | 'done'
  | 'todo'
  | 'failed'
  | 'awaiting'
  | 'idle'

const map: Record<StatusKind, { color: string; glow: string }> = {
  running: { color: '#7fb0ff', glow: 'rgba(127,176,255,0.55)' },
  done: { color: '#7fe7c4', glow: 'rgba(127,231,196,0.55)' },
  todo: { color: '#b58fff', glow: 'rgba(181,143,255,0.55)' },
  failed: { color: '#ff8b9a', glow: 'rgba(255,139,154,0.55)' },
  awaiting: { color: '#ffd88f', glow: 'rgba(255,216,143,0.55)' },
  idle: { color: '#6f6a8f', glow: 'rgba(111,106,143,0.4)' },
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
  const { color, glow } = map[status]
  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${pulse ? 'animate-pulse' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        boxShadow: `0 0 8px ${glow}`,
      }}
    />
  )
}
