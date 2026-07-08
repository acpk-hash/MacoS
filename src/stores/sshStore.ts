// SSH 远程会话状态（G2c）。连接管理 + 远程命令终端。
//
// 安全边界：密码 / passphrase / 私钥内容只在「连接」调用的入参里出现一次，
// 绝不写入本 store、不落库、不打日志。「记住主机」只持久化 host/port/user/
// 认证方式/密钥路径这些非机密项到 settings。
import { create } from 'zustand'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

/** 一个已建立的 SSH 连接（后端 AppState 里持有真正的会话句柄）。 */
export interface SshConn {
  conn_id: string
  host: string
  port: number
  user: string
  /** 远程浏览根（连接时解析的 home 目录，或 "/"）。 */
  root: string
}

/** 一条远程命令的执行结果。 */
export interface SshExecResult {
  stdout: string
  stderr: string
  exit: number
}

/** 终端里的一行历史（命令 + 输出）。 */
export interface TermLine {
  id: string
  cmd: string
  stdout: string
  stderr: string
  exit: number
}

/** 持久化的「记住主机」项——不含任何机密。 */
export interface SavedHost {
  host: string
  port: number
  user: string
  authKind: 'password' | 'key'
  keyPath?: string
}

export type SshAuthKind = 'password' | 'key'

export interface SshConnectInput {
  host: string
  port: number
  user: string
  authKind: SshAuthKind
  /** 仅用于本次调用，随后立即丢弃。 */
  password?: string
  keyPath?: string
  passphrase?: string
  /** 勾选后把非机密项写入 settings。 */
  remember?: boolean
}

const SAVED_KEY = 'ssh_saved_hosts'

async function persistSaved(list: SavedHost[]): Promise<void> {
  try {
    await tauriInvoke<void>('settings_set', { key: SAVED_KEY, value: JSON.stringify(list) })
  } catch {
    /* best effort */
  }
}

interface SshStore {
  conns: SshConn[]
  connecting: boolean
  error: string | null

  savedHosts: SavedHost[]

  /** 终端当前作用的连接 id（null = 未选择）。 */
  termConnId: string | null
  termLines: TermLine[]
  termRunning: boolean

  connect: (input: SshConnectInput) => Promise<SshConn | null>
  disconnect: (connId: string) => Promise<void>
  runExec: (connId: string, command: string) => Promise<void>
  setTermConn: (connId: string) => void
  loadSaved: () => Promise<void>
  removeSaved: (host: string, user: string, port: number) => Promise<void>
  clearError: () => void
}

export const useSshStore = create<SshStore>((set, get) => ({
  conns: [],
  connecting: false,
  error: null,
  savedHosts: [],
  termConnId: null,
  termLines: [],
  termRunning: false,

  connect: async (input) => {
    if (!isTauri) return null
    set({ connecting: true, error: null })
    const auth =
      input.authKind === 'password'
        ? { kind: 'password', password: input.password ?? '' }
        : { kind: 'key', keyPath: input.keyPath ?? '', passphrase: input.passphrase || null }
    try {
      const conn = await tauriInvoke<SshConn>('ssh_connect', {
        host: input.host.trim(),
        port: input.port,
        user: input.user.trim(),
        auth,
      })
      set((s) => ({
        conns: [...s.conns.filter((c) => c.conn_id !== conn.conn_id), conn],
        connecting: false,
        termConnId: s.termConnId ?? conn.conn_id,
      }))
      if (input.remember) {
        const h: SavedHost = {
          host: conn.host,
          port: conn.port,
          user: conn.user,
          authKind: input.authKind,
          keyPath: input.authKind === 'key' ? input.keyPath : undefined,
        }
        const next = [
          h,
          ...get().savedHosts.filter(
            (x) => !(x.host === h.host && x.user === h.user && x.port === h.port),
          ),
        ].slice(0, 12)
        set({ savedHosts: next })
        void persistSaved(next)
      }
      return conn
    } catch (e) {
      set({ connecting: false, error: `连接失败：${String(e)}` })
      return null
    }
  },

  disconnect: async (connId) => {
    if (!isTauri) return
    try {
      await tauriInvoke<void>('ssh_disconnect', { connId })
    } catch {
      /* best effort — drop it locally regardless */
    }
    set((s) => {
      const conns = s.conns.filter((c) => c.conn_id !== connId)
      return {
        conns,
        termConnId: s.termConnId === connId ? (conns[0]?.conn_id ?? null) : s.termConnId,
        termLines: s.termConnId === connId ? [] : s.termLines,
      }
    })
  },

  runExec: async (connId, command) => {
    if (!isTauri || !command.trim()) return
    set({ termRunning: true, error: null })
    try {
      const res = await tauriInvoke<SshExecResult>('ssh_exec', {
        connId,
        command: command.trim(),
      })
      set((s) => ({
        termRunning: false,
        termLines: [
          ...s.termLines,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            cmd: command.trim(),
            stdout: res.stdout,
            stderr: res.stderr,
            exit: res.exit,
          },
        ].slice(-200),
      }))
    } catch (e) {
      set({ termRunning: false, error: `执行失败：${String(e)}` })
    }
  },

  setTermConn: (connId) => set({ termConnId: connId }),

  loadSaved: async () => {
    if (!isTauri) return
    try {
      const all = await tauriInvoke<Record<string, string>>('settings_get_all')
      const raw = all[SAVED_KEY]
      if (raw) set({ savedHosts: JSON.parse(raw) as SavedHost[] })
    } catch {
      /* best effort */
    }
  },

  removeSaved: async (host, user, port) => {
    const next = get().savedHosts.filter(
      (x) => !(x.host === host && x.user === user && x.port === port),
    )
    set({ savedHosts: next })
    void persistSaved(next)
  },

  clearError: () => set({ error: null }),
}))
