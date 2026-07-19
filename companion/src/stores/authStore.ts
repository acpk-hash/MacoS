import { create } from 'zustand'
import {
  login as apiLogin,
  register as apiRegister,
  apiLogout,
  registerDevice,
  getDeviceId,
  getStoredUsername,
  clearAuth,
  refreshTokens,
  isLoggedIn,
} from '../lib/api'

const LS_BASE = 'iris.remote.'
const LM_KEY = 'iris.local_mode'

interface AuthState {
  loggedIn: boolean
  username: string
  accessToken: string | null
  deviceId: string | null
  busy: boolean
  error: string | null
  checked: boolean
  localMode: boolean

  login: (username: string, password: string, isRegister?: boolean) => Promise<void>
  logout: () => Promise<void>
  hydrate: () => Promise<void>
  enterLocalMode: () => void
  openPortal: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  loggedIn: false,
  username: '',
  accessToken: null,
  deviceId: null,
  busy: false,
  error: null,
  checked: false,
  localMode: localStorage.getItem(LM_KEY) === '1',

  async hydrate() {
    if (isLoggedIn()) {
      const ok = await refreshTokens().catch(() => false)
      if (ok) {
        const access = localStorage.getItem(LS_BASE + 'access_token')
        const deviceId = localStorage.getItem(LS_BASE + 'device_id')
        const username = getStoredUsername() ?? ''
        set({ loggedIn: true, accessToken: access, deviceId, username, checked: true })
        return
      }
    }
    set({ checked: true })
  },

  async login(username, password, isRegister = false) {
    set({ busy: true, error: null })
    try {
      const fn = isRegister ? apiRegister : apiLogin
      const resolvedUsername = await fn(username, password)

      let deviceId = getDeviceId()
      if (!deviceId) {
        const ua = navigator.userAgent
        const name = /Android/i.test(ua) ? 'Android 手机' : /iPhone/i.test(ua) ? 'iPhone' : '手机端'
        deviceId = await registerDevice('mobile', name)
      }

      localStorage.removeItem(LM_KEY)
      set({
        loggedIn: true,
        username: resolvedUsername,
        accessToken: localStorage.getItem(LS_BASE + 'access_token'),
        deviceId,
        busy: false,
        error: null,
        localMode: false,
      })
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  async logout() {
    set({ busy: true })
    try { await apiLogout() } catch { /* best-effort */ }
    clearAuth()
    localStorage.setItem(LM_KEY, '1')
    set({
      loggedIn: false,
      username: '',
      accessToken: null,
      deviceId: null,
      busy: false,
      error: null,
      localMode: true,
    })
  },

  enterLocalMode() {
    localStorage.setItem(LM_KEY, '1')
    set({ localMode: true })
  },

  openPortal() {
    localStorage.removeItem(LM_KEY)
    set({ localMode: false })
  },
}))
