import { useState } from 'react'
import Logo from '../components/Logo'
import { useAuthStore } from '../stores/authStore'

// ── 登录/注册门户（蓝白主题） ─────────────────────────────────────────────────
//
// 未登录且未选择本地模式时全屏显示。用户名+密码，注册即登录（后端
// sync_register 成功后直接持有会话）。保留「本地模式（暂不登录）」入口：
// 不登录也能使用全部本地功能，只是不跨端同步——避免 VPS 不可达时锁死用户。

type Mode = 'login' | 'register'

export default function Login() {
  const { login, enterLocalMode } = useAuthStore()
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const switchMode = (m: Mode) => {
    setMode(m)
    setError(null)
  }

  const submit = async () => {
    if (busy) return
    const name = username.trim()
    if (!name) {
      setError('请输入用户名')
      return
    }
    if (!password) {
      setError('请输入密码')
      return
    }
    if (mode === 'register') {
      if (password.length < 8) {
        setError('密码至少 8 位')
        return
      }
      if (password !== password2) {
        setError('两次输入的密码不一致')
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      await login(name, password, mode === 'register')
      // 成功后 authStore 状态翻转，门户自动卸载。
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
  }

  const inputCls =
    'w-full bg-surface border border-line rounded-input px-3 py-2.5 text-sm text-ink ' +
    'placeholder-ink-dim focus:outline-none focus:border-primary transition-colors'

  const tabCls = (active: boolean) =>
    `flex-1 py-2 text-sm font-medium rounded-btn transition-colors ${
      active
        ? 'bg-surface text-primary shadow-card'
        : 'text-ink-muted hover:text-ink'
    }`

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        {/* 品牌区 */}
        <div className="flex flex-col items-center mb-6">
          <Logo size={52} />
          <h1 className="mt-3 text-xl font-extrabold text-primary">AgentBoard</h1>
          <p className="mt-1.5 text-xs text-ink-muted text-center leading-relaxed">
            登录以在手机和电脑间同步数据 —— 任务、进度与对话实时互通
          </p>
        </div>

        {/* 卡片 */}
        <div className="bg-surface border border-line rounded-card shadow-card p-5 space-y-4">
          {/* 登录/注册切换 */}
          <div className="flex gap-1 bg-surface-2 rounded-btn p-1">
            <button className={tabCls(mode === 'login')} onClick={() => switchMode('login')}>
              登录
            </button>
            <button className={tabCls(mode === 'register')} onClick={() => switchMode('register')}>
              注册
            </button>
          </div>

          {error && (
            <p className="text-xs text-failed bg-[#f851491a] border border-[#f8514940] rounded-lg px-3 py-2 break-words">
              {error}
            </p>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-ink-muted mb-1">用户名</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="3-32 位（字母/数字/_.-）"
                autoComplete="username"
                autoFocus
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-ink-muted mb-1">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="至少 8 位"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className={inputCls}
              />
            </div>
            {mode === 'register' && (
              <div>
                <label className="block text-xs text-ink-muted mb-1">确认密码</label>
                <input
                  type="password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="再输入一次"
                  autoComplete="new-password"
                  className={inputCls}
                />
              </div>
            )}
          </div>

          <button
            onClick={() => void submit()}
            disabled={busy}
            className="w-full py-2.5 bg-primary hover:bg-primary-hover disabled:opacity-50
                       text-white text-sm font-medium rounded-btn transition-colors"
          >
            {busy ? '处理中…' : mode === 'register' ? '注册并登录' : '登录'}
          </button>

          <p className="text-xs text-ink-dim leading-relaxed">
            {mode === 'register'
              ? '注册即登录。登录后，本机已有的任务与对话会自动上传到该账号，在手机端登录同一账号即可查看。'
              : '登录后，本机已有的任务与对话会自动上传到该账号；数据按账号隔离，各账号互不可见。'}
          </p>
        </div>

        {/* 本地模式入口 */}
        <div className="mt-4 text-center">
          <button
            onClick={enterLocalMode}
            className="text-sm text-ink-muted hover:text-primary transition-colors"
          >
            本地模式（暂不登录）→
          </button>
          <p className="mt-1 text-xs text-ink-dim">
            不登录也可使用全部本地功能，只是数据不会在手机与电脑间同步
          </p>
        </div>
      </div>
    </div>
  )
}
