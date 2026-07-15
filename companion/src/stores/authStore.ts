import { create } from 'zustand'
import {
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  registerDevice,
  getDeviceId,
  getStoredUsername,
  clearAuth,
} from '../lib/api'

const LS_BASE = 'iris.remote.'

interface AuthState {
  loggedIn: boolean
  username: string
  accessToken: string | null
  deviceId: string | null
  busy: boolean
  error: string | null
  isHydrated: boolean

  login: (username: string, password: string, isRegister?: boolean) => Promise<void>
  logout: () => Promise<void>
  hydrate: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  loggedIn: false,
  username: '',
  accessToken: null,
  deviceId: null,
  busy: false,
  error: null,
  isHydrated: false,

  hydrate() {
    const access = localStorage.getItem(LS_BASE + 'access_token')
    const deviceId = localStorage.getItem(LS_BASE + 'device_id')
    const username = getStoredUsername() ?? ''
    if (access && username) {
      set({ loggedIn: true, accessToken: access, deviceId, username })
    }
    set({ isHydrated: true })
  },

  async login(username, password, isRegister = false) {
    set({ busy: true, error: null })
    try {
      const fn = isRegister ? apiRegister : apiLogin
      const resolvedUsername = await fn(username, password)

      let deviceId = getDeviceId()
      if (!deviceId) {
        const name = /Mobile|iPhone|Android/i.test(navigator.userAgent)
          ? '手机端'
          : '浏览器端'
        deviceId = await registerDevice('mobile', name)
      }

      set({
        loggedIn: true,
        username: resolvedUsername,
        accessToken: localStorage.getItem(LS_BASE + 'access_token'),
        deviceId,
        busy: false,
        error: null,
      })
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  async logout() {
    set({ busy: true })
    try {
      await apiLogout()
    } catch {
      // best-effort
    }
    clearAuth()
    set({
      loggedIn: false,
      username: '',
      accessToken: null,
      deviceId: null,
      busy: false,
      error: null,
    })
  },
}))
