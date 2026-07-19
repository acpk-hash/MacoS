import { useState, FormEvent } from 'react'
import { useAuthStore } from '../stores/authStore'
import Logo from '../components/Logo'

export default function Login() {
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { login, enterLocalMode, busy, error } = useAuthStore()

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (!username.trim()) errs.username = '请输入用户名'
    if (password.length < 8) errs.password = '密码至少 8 位'
    if (tab === 'register' && password !== confirmPw) errs.confirm = '两次密码不一致'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!validate()) return
    try {
      await login(username, password, tab === 'register')
    } catch {
      /* error is surfaced via store */
    }
  }

  const isRegister = tab === 'register'

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-5 animate-in">
      {/* ── Logo ─────────────────────────────────────────────────────── */}
      <div className="mb-10 flex flex-col items-center gap-3">
        <div className="p-3 rounded-2xl bg-editor shadow-lg border border-line">
          <Logo size={44} />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-bold text-ink tracking-tight">Iris</h1>
          <p className="text-sm text-ink-muted mt-0.5">你的全能 AI 工作台</p>
        </div>
      </div>

      {/* ── Card ──────────────────────────────────────────────────────── */}
      <div className="w-full max-w-sm bg-editor rounded-[18px] shadow-sm border border-line overflow-hidden">
        {/* Tab switch */}
        <div className="flex border-b border-line">
          {(['login', 'register'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setErrors({}); }}
              className={`flex-1 py-3.5 text-sm font-medium transition-colors relative ${
                tab === t
                  ? 'text-ink'
                  : 'text-ink-muted active:text-ink-dim'
              }`}
            >
              {t === 'login' ? '登录' : '注册'}
              {tab === t && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-10 h-[2.5px] bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          {/* Username */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted tracking-wide">
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
              className={`h-11 px-3.5 rounded-[10px] border bg-surface text-ink text-sm placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition ${
                errors.username ? 'border-failed' : 'border-line'
              }`}
            />
            {errors.username && (
              <p className="text-xs text-failed ml-1">{errors.username}</p>
            )}
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted tracking-wide">
              密码
            </label>
            <input
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码（至少 8 位）"
              className={`h-11 px-3.5 rounded-[10px] border bg-surface text-ink text-sm placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition ${
                errors.password ? 'border-failed' : 'border-line'
              }`}
            />
            {errors.password && (
              <p className="text-xs text-failed ml-1">{errors.password}</p>
            )}
          </div>

          {/* Confirm password (register only) */}
          {isRegister && (
            <div className="flex flex-col gap-1.5 animate-in">
              <label className="text-xs font-medium text-ink-muted tracking-wide">
                确认密码
              </label>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                placeholder="再次输入密码"
                className={`h-11 px-3.5 rounded-[10px] border bg-surface text-ink text-sm placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition ${
                  errors.confirm ? 'border-failed' : 'border-line'
                }`}
              />
              {errors.confirm && (
                <p className="text-xs text-failed ml-1">{errors.confirm}</p>
              )}
            </div>
          )}

          {/* Server error */}
          {error && (
            <div className="rounded-[10px] bg-failed/8 border border-failed/15 px-3.5 py-2.5 text-sm text-failed">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={busy}
            className="h-12 rounded-[10px] bg-primary text-white font-semibold text-sm active:opacity-90 disabled:opacity-50 transition-all mt-1 shadow-sm"
          >
            {busy ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                请稍候...
              </span>
            ) : (
              isRegister ? '创建账户' : '登录'
            )}
          </button>
        </form>
      </div>

      {/* ── Local mode ────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={enterLocalMode}
        className="mt-6 text-sm text-ink-dim active:text-ink-muted transition-colors py-2 px-4 rounded-[10px] active:bg-surface-2"
      >
        本地模式（暂不登录）
      </button>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <p className="mt-8 text-[11px] text-ink-faint text-center">
        Iris v0.14.0
      </p>
    </div>
  )
}
