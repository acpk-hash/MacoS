/**
 * Iris Mobile — API layer for sync server + AI chat relay.
 * Auth endpoints match the sync.rs protocol; chat relay calls the user's
 * configured provider directly from the browser.
 */

const LS_BASE = 'iris.remote.'

export function getBaseUrl(): string {
  const saved = localStorage.getItem(LS_BASE + 'base_url')
  if (saved) return saved
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return window.location.origin
  }
  return 'https://192-210-231-152.nip.io'
}

export function setBaseUrl(url: string): void {
  localStorage.setItem(LS_BASE + 'base_url', url.replace(/\/+$/, ''))
}

function getAccessToken(): string | null {
  return localStorage.getItem(LS_BASE + 'access_token')
}

function getRefreshToken(): string | null {
  return localStorage.getItem(LS_BASE + 'refresh_token')
}

function storeTokens(access: string, refresh: string): void {
  localStorage.setItem(LS_BASE + 'access_token', access)
  localStorage.setItem(LS_BASE + 'refresh_token', refresh)
}

export function storeDeviceId(id: string): void {
  localStorage.setItem(LS_BASE + 'device_id', id)
}

export function getDeviceId(): string | null {
  return localStorage.getItem(LS_BASE + 'device_id')
}

export function getStoredUsername(): string | null {
  return localStorage.getItem(LS_BASE + 'username')
}

export function clearAuth(): void {
  localStorage.removeItem(LS_BASE + 'access_token')
  localStorage.removeItem(LS_BASE + 'refresh_token')
  localStorage.removeItem(LS_BASE + 'device_id')
  localStorage.removeItem(LS_BASE + 'username')
}

export function isLoggedIn(): boolean {
  return !!getRefreshToken()
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuthResponse {
  ok: boolean
  user: { id?: number; username: string }
  access_token: string
  refresh_token: string
  error?: string
  message?: string
}

export interface DeviceInfo {
  id: string
  kind: string
  name: string
}

// ── Error mapping ────────────────────────────────────────────────────────────

function friendlyError(code: string, msg: string): string {
  switch (code) {
    case 'username_taken': return '用户名已被注册，请换一个'
    case 'bad_credentials': return '用户名或密码错误'
    case 'invalid_input': return msg || '输入不合法：用户名 3-32 位，密码至少 8 位'
    case 'rate_limited': return msg ? `操作过于频繁（${msg}）` : '操作过于频繁，请稍后再试'
    case 'bad_refresh': return '登录已失效，请重新登录'
    case 'no_token': case 'bad_token': return '登录状态无效，请重新登录'
    default: return msg || `请求失败：${code}`
  }
}

// ── Core fetch ───────────────────────────────────────────────────────────────

async function apiFetch(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<Response> {
  const base = getBaseUrl()
  const url = `${base}${path}`
  const token = getAccessToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(url, { ...options, headers })

  if ((res.status === 401 || res.status === 403) && retry) {
    const refreshed = await attemptRefresh()
    if (refreshed) return apiFetch(path, options, false)
  }

  return res
}

async function attemptRefresh(): Promise<boolean> {
  const rt = getRefreshToken()
  if (!rt) return false
  try {
    const base = getBaseUrl()
    const res = await fetch(`${base}/api/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    })
    if (!res.ok) return false
    const data = await res.json() as AuthResponse
    if (!data.ok) return false
    storeTokens(data.access_token, data.refresh_token)
    localStorage.setItem(LS_BASE + 'username', data.user.username)
    return true
  } catch {
    return false
  }
}

async function expectOk(res: Response): Promise<Record<string, unknown>> {
  const body = await res.json() as Record<string, unknown>
  if (body.ok === false) {
    const code = (body.error as string) ?? 'unknown'
    const msg = (body.message as string) ?? ''
    throw new Error(friendlyError(code, msg))
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return body
}

// ── Auth API ─────────────────────────────────────────────────────────────────

export async function register(username: string, password: string): Promise<string> {
  const res = await apiFetch('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  const data = await expectOk(res) as unknown as AuthResponse
  storeTokens(data.access_token, data.refresh_token)
  localStorage.setItem(LS_BASE + 'username', data.user.username)
  return data.user.username
}

export async function login(username: string, password: string): Promise<string> {
  const res = await apiFetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  const data = await expectOk(res) as unknown as AuthResponse
  storeTokens(data.access_token, data.refresh_token)
  localStorage.setItem(LS_BASE + 'username', data.user.username)
  return data.user.username
}

export async function refreshTokens(): Promise<boolean> {
  return attemptRefresh()
}

export async function getDevices(): Promise<DeviceInfo[]> {
  const res = await apiFetch('/api/devices')
  const data = await expectOk(res)
  return (data.devices as DeviceInfo[]) ?? []
}

export async function registerDevice(kind: string, name: string): Promise<string> {
  const res = await apiFetch('/api/devices', {
    method: 'POST',
    body: JSON.stringify({ kind, name }),
  })
  const data = await expectOk(res)
  const device = data.device as { id: string } | undefined
  const id = device?.id ?? ''
  if (id) storeDeviceId(id)
  return id
}

export async function apiLogout(): Promise<void> {
  const rt = getRefreshToken()
  const token = getAccessToken()
  try {
    const base = getBaseUrl()
    await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ refresh_token: rt ?? '' }),
    })
  } catch { /* best-effort */ }
  clearAuth()
}

// ── AI Chat Relay (direct to provider) ───────────────────────────────────────

export interface ChatStreamOpts {
  messages: Array<{ role: string; content: string }>
  model: string
  baseUrl: string
  apiKey: string
  onToken: (t: string) => void
  onDone: () => void
  onError: (e: string) => void
  signal?: AbortSignal
}

export async function chatStream(opts: ChatStreamOpts) {
  const { messages, model, baseUrl, apiKey, onToken, onDone, onError, signal } = opts
  const base = baseUrl.replace(/\/+$/, '')
  const url = base + (base.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions')

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    })
    if (!res.ok) {
      const e = await res.text()
      onError(`API ${res.status}: ${e.slice(0, 200)}`)
      return
    }
    const reader = res.body?.getReader()
    if (!reader) { onError('无法读取流'); return }
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const l of lines) {
        const t = l.trim()
        if (!t || !t.startsWith('data: ')) continue
        const d = t.slice(6)
        if (d === '[DONE]') { onDone(); return }
        try {
          const p = JSON.parse(d)
          const c = p.choices?.[0]?.delta?.content
          if (c) onToken(c)
        } catch { /* skip */ }
      }
    }
    onDone()
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    onError(String(e))
  }
}

// ── Provider settings (local storage) ────────────────────────────────────────

export interface MobileProvider {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

const PROVIDERS_KEY = 'iris.providers'
const DEF_PROVIDER_KEY = 'iris.default_provider'

export function getProviders(): MobileProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveProviders(ps: MobileProvider[]) {
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(ps))
}

export function getDefaultProviderId(): string | null {
  return localStorage.getItem(DEF_PROVIDER_KEY)
}

export function setDefaultProviderId(id: string) {
  localStorage.setItem(DEF_PROVIDER_KEY, id)
}

const BUILTIN_AGNES: MobileProvider = {
  id: 'builtin-agnes',
  label: 'Iris Free (Agnes)',
  baseUrl: 'http://107.174.70.15:8080/v1',
  apiKey: 'sk-434c50a59112894d00b27d8dd4ed2d413ea75bf51f462fc66666c0a57914c5a4',
  model: 'agnes-2.0-flash',
  enabled: true,
}

export function seedBuiltinProviders(): void {
  const ps = getProviders()
  if (ps.some(p => p.id === 'builtin-agnes')) return
  saveProviders([BUILTIN_AGNES, ...ps])
  if (!getDefaultProviderId()) setDefaultProviderId('builtin-agnes')
}

export function getActiveProvider(): MobileProvider | null {
  const ps = getProviders()
  const did = getDefaultProviderId()
  if (did) { const p = ps.find(x => x.id === did && x.enabled); if (p) return p }
  return ps.find(x => x.enabled) || null
}
