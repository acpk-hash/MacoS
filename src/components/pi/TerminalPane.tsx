// 真交互式终端（P8）— xterm.js + 后端 PTY（portable-pty / ConPTY）。
// 挂载即 pty_open（cwd=当前工作目录）；用户键入 onData → pty_write；
// pty-output 事件（base64 字节）→ term.write；FitAddon + ResizeObserver
// → pty_resize。卸载 / 切换工作目录（key=root 强制重挂）时 pty_close 清理。
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

/** base64 → 原始字节（直接喂 xterm 的 UTF-8 解码器，多字节安全）。 */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 浅色终端主题配色（对齐 tailwind.config.js 的 v0.11 浅色 token）。 */
const TRAE_THEME = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#202123',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(32, 33, 35, 0.15)',
  black: '#1f1f1e',
  red: '#c5221f',
  green: '#137333',
  yellow: '#a05a00',
  blue: '#0b57d0',
  magenta: '#8e24aa',
  cyan: '#007b83',
  white: '#8a8a85',
  brightBlack: '#666660',
  brightRed: '#d0342c',
  brightGreen: '#10a37f',
  brightYellow: '#b7791f',
  brightBlue: '#0d8de3',
  brightMagenta: '#a352cc',
  brightCyan: '#0997a5',
  brightWhite: '#b3b3ad',
}

export default function TerminalPane({ cwd, visible }: { cwd: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const visRef = useRef(visible)
  visRef.current = visible

  useEffect(() => {
    const host = hostRef.current
    if (!isTauri || !host) return
    let disposed = false
    let unOut: (() => void) | undefined
    let unExit: (() => void) | undefined

    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: TRAE_THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
    } catch {
      /* 容器尚无尺寸时忽略 */
    }
    termRef.current = term
    fitRef.current = fit

    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const { listen } = await import('@tauri-apps/api/event')
        // 先挂监听再开 PTY，避免早期输出（shell 横幅/提示符）丢失。
        const pending: Array<{ id: string; data: string }> = []
        let openId: string | null = null
        unOut = await listen<{ id: string; data: string }>('pty-output', (e) => {
          if (openId == null) {
            pending.push(e.payload)
            return
          }
          if (e.payload.id === openId) term.write(b64ToBytes(e.payload.data))
        })
        unExit = await listen<{ id: string; code: number | null }>('pty-exit', (e) => {
          if (e.payload.id !== idRef.current) return
          idRef.current = null
          const code = e.payload.code
          term.write(
            `\r\n\x1b[38;5;103m[进程已退出${code != null ? `，code=${code}` : ''}]\x1b[0m\r\n`,
          )
        })

        const id = await invoke<string>('pty_open', {
          cwd,
          cols: term.cols,
          rows: term.rows,
        })
        if (disposed) {
          void invoke('pty_close', { id })
          return
        }
        idRef.current = id
        openId = id
        for (const p of pending) {
          if (p.id === id) term.write(b64ToBytes(p.data))
        }
        pending.length = 0

        term.onData((data) => {
          if (idRef.current) void invoke('pty_write', { id: idRef.current, data })
        })
        term.onResize(({ cols, rows }) => {
          if (idRef.current) void invoke('pty_resize', { id: idRef.current, cols, rows })
        })
      } catch (err) {
        term.writeln(`\x1b[31m启动终端失败: ${String(err)}\x1b[0m`)
      }
    })()

    const ro = new ResizeObserver(() => {
      if (!visRef.current) return
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      unOut?.()
      unExit?.()
      const id = idRef.current
      idRef.current = null
      if (id) {
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('pty_close', { id }))
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [cwd])

  // 从隐藏切回可见：容器刚有尺寸，补一次 fit + 聚焦。
  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
