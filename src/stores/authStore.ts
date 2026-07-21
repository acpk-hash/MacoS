import { create } from 'zustand'

// ── Types (mirror Rust sync::SyncStatusInfo) ──────────────────────────────────

export interface SyncDeviceInfo {
  id: string
  kind: string
  name: string
}

export interface SyncStatusInfo {
  /** Sync switch (settings `sync_enabled`). */
  enabled: boolean
  /** Whether a refresh token is held (i.e. an account is logged in). */
  logged_in: boolean
  /** disabled | disconnected | connecting | connected | reconnecting */
  state: string
  username: string | null
  device_count: number
  devices: SyncDeviceInfo[]
  last_error: string | null
}

// ── Tauri guard ───────────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── Local-mode persistence ────────────────────────────────────────────────────
//
// 「本地模式（暂不登录）」是一个显式选择：记在 localStorage，重启后不再弹
// 登录门户；登录成功即清除，退出登录时重新落回本地模式（不锁死用户）。

const LOCAL_MODE_KEY = 'ab_local_mode'

function readLocalMode(): boolean {
  try {
    return localStorage.getItem(LOCAL_MODE_KEY) === '1'
  } catch {
    return false
  }
}

function writeLocalMode(v: boolean) {
  try {
    if (v) localStorage.setItem(LOCAL_MODE_KEY, '1')
    else localStorage.removeItem(LOCAL_MODE_KEY)
  } catch {
    // localStorage 不可用时仅内存生效
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AuthStore {
  /** Initial `sync_status` probe finished (gate can render). */
  checked: boolean
  status: SyncStatusInfo | null
  /** User explicitly chose "本地模式（暂不登录）". */
  localMode: boolean
  /** Convenience: status?.logged_in ?? false. */
  loggedIn: boolean
  username: string | null

  /** Probe once at startup + start a light poll. Idempotent. */
  init: () => Promise<void>
  refresh: () => Promise<void>
  /** Register (register=true) or log in. Throws a human-readable message on
   *  failure. On success sync is enabled and the current local snapshot is
   *  pushed to the account by the backend master loop. */
  login: (username: string, password: string, register: boolean) => Promise<void>
  /** Log out and fall back to local mode (app stays fully usable offline). */
  logout: () => Promise<void>
  /** Enter local mode without logging in (persisted across restarts). */
  enterLocalMode: () => void
  /** Re-open the login portal from local mode. */
  openPortal: () => void
}

let pollTimer: ReturnType<typeof setInterval> | null = null

export const useAuthStore = create<AuthStore>((set, get) => ({
  checked: false,
  status: null,
  localMode: readLocalMode(),
  loggedIn: false,
  username: null,

  init: async () => {
    if (!isTauri) {
      // 浏览器开发环境：无 Tauri 后端，直接以本地模式进入。
      set({ checked: true, localMode: true })
      return
    }
    await get().refresh()
    set({ checked: true })
    if (pollTimer == null) {
      pollTimer = setInterval(() => {
        void get().refresh()
      }, 10_000)
    }
  },

  refresh: async () => {
    if (!isTauri) return
    try {
      const status = await tauriInvoke<SyncStatusInfo>('sync_status')
      set({
        status,
        loggedIn: status.logged_in,
        username: status.username,
      })
    } catch (e) {
      console.warn('[authStore] sync_status failed:', e)
    }
  },

  login: async (username, password, register) => {
    await tauriInvoke(register ? 'sync_register' : 'sync_login', {
      username,
      password,
    })
    writeLocalMode(false)
    set({ localMode: false })
    // Backend switched to a per-account database; full reload ensures
    // all components re-fetch from the new (empty) database.
    window.location.reload()
  },

  logout: async () => {
    writeLocalMode(true)
    try {
      await tauriInvoke('sync_logout')
    } catch (e) {
      console.warn('[authStore] sync_logout failed:', e)
    }
    // Backend switched back to the default database; full reload ensures
    // UI shows the local-mode data (not the previous account's data).
    window.location.reload()
  },

  enterLocalMode: () => {
    writeLocalMode(true)
    set({ localMode: true })
  },

  openPortal: () => {
    writeLocalMode(false)
    set({ localMode: false })
  },
}))

/** Startup hook: probe login state once before the gate renders. */
export async function initAuth(): Promise<void> {
  await useAuthStore.getState().init()
}
