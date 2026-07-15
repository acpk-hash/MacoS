const LS_BASE = 'iris.remote.'

export function getBaseUrl(): string {
  const saved = localStorage.getItem(LS_BASE + 'base_url')
  if (saved) return saved
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return window.location.origin
  }
  return 'https://192.210.231.152:8443'
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

// ── Types (matching sync.rs protocol) ───────────────────────────────────────

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

// ── Friendly error mapping (matching sync.rs) ───────────────────────────────

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

// ── Core fetch helper ────────────────────────────────────────────────────────

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
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return body
}

// ── Public API (paths match sync.rs) ────────────────────────────────────────

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

export async function logout(): Promise<void> {
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
  } catch {
    // best-effort
  }
  clearAuth()
}
