import { WsState } from '../lib/ws'

interface Props {
  state: WsState
}

export default function StatusDot({ state }: Props) {
  if (state === 'connected') {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-mint opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-mint" />
      </span>
    )
  }
  if (state === 'connecting' || state === 'reconnecting') {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gold opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-gold" />
      </span>
    )
  }
  return <span className="inline-flex rounded-full h-2.5 w-2.5 bg-coral" />
}
