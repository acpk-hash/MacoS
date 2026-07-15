import { getBaseUrl } from './api'

export type WsState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface WsCallbacks {
  onSnapshot: (kind: string, data: unknown) => void
  onEvent: (type: string, data: unknown) => void
  onStateChange: (state: WsState) => void
}

interface WsMessage {
  type: string
  payload?: {
    kind?: string
    type?: string
    data?: unknown
  }
}

export class WsManager {
  private ws: WebSocket | null = null
  private accessToken: string
  private deviceId: string
  private callbacks: WsCallbacks
  private state: WsState = 'disconnected'
  private retryDelay = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(accessToken: string, deviceId: string, callbacks: WsCallbacks) {
    this.accessToken = accessToken
    this.deviceId = deviceId
    this.callbacks = callbacks
  }

  connect(): void {
    this.closed = false
    this.openSocket()
  }

  private openSocket(): void {
    this.setState('connecting')

    const base = getBaseUrl()
    const wsBase = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
    const url = `${wsBase}/ws?token=${encodeURIComponent(this.accessToken)}&device_id=${encodeURIComponent(this.deviceId)}`

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.retryDelay = 1000
      this.setState('connected')
      this.startPing()
    }

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage
        this.handleMessage(msg)
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      this.stopPing()
      if (!this.closed) {
        this.scheduleReconnect()
      } else {
        this.setState('disconnected')
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror, so nothing extra needed here
    }
  }

  private handleMessage(msg: WsMessage): void {
    const p = msg.payload
    if (msg.type === 'snapshot_update' && p) {
      this.callbacks.onSnapshot(p.kind ?? '', p.data)
    } else if (msg.type === 'event_append' && p) {
      this.callbacks.onEvent(p.type ?? '', p.data)
    }
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting')
    this.retryTimer = setTimeout(() => {
      if (!this.closed) {
        this.openSocket()
      }
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' })
    }, 25_000)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private setState(s: WsState): void {
    if (this.state !== s) {
      this.state = s
      this.callbacks.onStateChange(s)
    }
  }

  private sendRaw(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  sendCommand(command: string, data: unknown): void {
    this.sendRaw({ type: 'command', payload: { command, data } })
  }

  close(): void {
    this.closed = true
    this.stopPing()
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.setState('disconnected')
  }
}
