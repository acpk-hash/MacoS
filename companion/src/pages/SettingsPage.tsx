import { useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useSyncStore } from '../stores/syncStore'
import { getBaseUrl, setBaseUrl } from '../lib/api'
import StatusDot from '../components/StatusDot'

export default function SettingsPage() {
  const { username, logout, busy } = useAuthStore()
  const wsState = useSyncStore((s) => s.wsState)
  const [serverUrl, setServerUrl] = useState(getBaseUrl)
  const [urlSaved, setUrlSaved] = useState(false)

  function saveUrl() {
    const trimmed = serverUrl.trim().replace(/\/$/, '')
    if (!trimmed) return
    setBaseUrl(trimmed)
    setServerUrl(trimmed)
    setUrlSaved(true)
    setTimeout(() => setUrlSaved(false), 2000)
  }

  const wsStateLabels: Record<string, string> = {
    connected: '已连接',
    connecting: '连接中',
    reconnecting: '重连中',
    disconnected: '未连接',
  }

  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3">
        <h1 className="text-lg font-bold text-ink">设置</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-4">
        {/* Account section */}
        <section>
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2 px-1">账户</p>
          <div className="bg-editor rounded-xl border border-line divide-y divide-line">
            <div className="px-4 py-3.5 flex items-center justify-between">
              <div>
                <p className="text-xs text-ink-muted">用户名</p>
                <p className="text-sm font-medium text-ink mt-0.5">{username || '—'}</p>
              </div>
              <div className="w-8 h-8 rounded-full bg-primary text-white text-sm font-bold flex items-center justify-center">
                {username ? username[0].toUpperCase() : '?'}
              </div>
            </div>
            <div className="px-4 py-3.5 flex items-center justify-between">
              <div>
                <p className="text-xs text-ink-muted">同步状态</p>
                <p className="text-sm font-medium text-ink mt-0.5">{wsStateLabels[wsState] ?? wsState}</p>
              </div>
              <StatusDot state={wsState} />
            </div>
          </div>
        </section>

        {/* Server section */}
        <section>
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2 px-1">服务器</p>
          <div className="bg-editor rounded-xl border border-line p-4 flex flex-col gap-3">
            <div>
              <label className="text-xs text-ink-muted block mb-1.5">服务器地址</label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://192.210.231.152:8443"
                  className="flex-1 h-10 px-3 rounded-xl border border-line bg-bg text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition font-mono"
                />
                <button
                  onClick={saveUrl}
                  className={`shrink-0 px-4 h-10 rounded-xl text-sm font-medium transition-colors ${
                    urlSaved
                      ? 'bg-mint/10 text-mint'
                      : 'bg-primary text-white active:bg-primary-hover'
                  }`}
                >
                  {urlSaved ? '已保存' : '保存'}
                </button>
              </div>
              <p className="text-[11px] text-ink-faint mt-1.5">
                修改后需重新打开应用生效
              </p>
            </div>
          </div>
        </section>

        {/* About section */}
        <section>
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2 px-1">关于</p>
          <div className="bg-editor rounded-xl border border-line divide-y divide-line">
            <div className="px-4 py-3.5 flex items-center justify-between">
              <p className="text-sm text-ink">版本</p>
              <p className="text-sm text-ink-muted font-mono">v0.14.0</p>
            </div>
            <div className="px-4 py-3.5 flex items-center justify-between">
              <p className="text-sm text-ink">应用名称</p>
              <p className="text-sm text-ink-muted">Iris Remote</p>
            </div>
          </div>
        </section>

        {/* Logout */}
        <button
          onClick={() => logout()}
          disabled={busy}
          className="w-full h-12 rounded-xl bg-coral/10 text-coral font-semibold text-sm border border-coral/20 active:bg-coral/20 disabled:opacity-50 transition-colors mt-2"
        >
          {busy ? '退出中…' : '退出登录'}
        </button>
      </div>
    </div>
  )
}
