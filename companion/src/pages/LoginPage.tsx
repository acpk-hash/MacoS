import { useState, FormEvent } from 'react'
import { useAuthStore } from '../stores/authStore'

export default function LoginPage() {
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { login, busy, error } = useAuthStore()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    await login(username, password, tab === 'register')
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-8 flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-lg">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="10" r="5" fill="white" opacity="0.9" />
            <ellipse cx="16" cy="23" rx="9" ry="6" fill="white" opacity="0.6" />
            <circle cx="16" cy="10" r="2.5" fill="white" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-ink tracking-tight">Iris Remote</h1>
        <p className="text-sm text-ink-muted">手机控制桌面端</p>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm bg-editor rounded-2xl shadow-sm border border-line overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-line">
          {(['login', 'register'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-3.5 text-sm font-medium transition-colors ${
                tab === t
                  ? 'text-primary border-b-2 border-primary -mb-px'
                  : 'text-ink-muted'
              }`}
            >
              {t === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              用户名
            </label>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="输入用户名"
              className="h-11 px-3.5 rounded-xl border border-line bg-bg text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted uppercase tracking-wide">
              密码
            </label>
            <input
              type="password"
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码"
              className="h-11 px-3.5 rounded-xl border border-line bg-bg text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
              required
            />
          </div>

          {error && (
            <div className="rounded-xl bg-coral/10 border border-coral/20 px-3.5 py-2.5 text-sm text-coral">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="h-11 rounded-xl bg-primary text-white font-medium text-sm active:bg-primary-hover disabled:opacity-50 transition-colors mt-1"
          >
            {busy ? '请稍候…' : tab === 'login' ? '登录' : '注册'}
          </button>
        </form>
      </div>

      <p className="mt-6 text-xs text-ink-faint text-center">
        Iris Remote v0.14.0 · 连接到桌面端 Iris
      </p>
    </div>
  )
}
