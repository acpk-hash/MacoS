import { useState, useEffect } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useSyncStore } from '../stores/syncStore'
import {
  getBaseUrl,
  setBaseUrl,
  getProviders,
  saveProviders,
  getDefaultProviderId,
  setDefaultProviderId,
  getDevices,
  MobileProvider,
  DeviceInfo,
} from '../lib/api'
function StatusDot({ state }: { state: string }) {
  const cls = state === 'connected' ? 'dot-ok' : state === 'connecting' || state === 'reconnecting' ? 'dot-warn pulse' : 'dot-off'
  return <span className={`dot ${cls}`} />
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function uid(): string {
  return `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

const wsLabels: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  disconnected: '未连接',
}

const wsColors: Record<string, string> = {
  connected: 'text-done',
  connecting: 'text-running',
  reconnecting: 'text-awaiting',
  disconnected: 'text-failed',
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Settings page                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */

export default function Settings() {
  const { loggedIn, username, logout, openPortal, busy } = useAuthStore()
  const wsState = useSyncStore((s) => s.wsState)

  /* ── Provider state ──────────────────────────────────────────────────── */
  const [providers, setProviders] = useState<MobileProvider[]>(getProviders)
  const [defaultId, setDefaultId] = useState<string | null>(getDefaultProviderId)
  const [showAddForm, setShowAddForm] = useState(false)
  const [formLabel, setFormLabel] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formApiKey, setFormApiKey] = useState('')
  const [formModel, setFormModel] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  /* ── Server URL ──────────────────────────────────────────────────────── */
  const [serverUrl, setServerUrl] = useState(getBaseUrl)
  const [urlSaved, setUrlSaved] = useState(false)

  /* ── Devices ─────────────────────────────────────────────────────────── */
  const [devices, setDevices] = useState<DeviceInfo[]>([])

  useEffect(() => {
    if (loggedIn) {
      getDevices().then(setDevices).catch(() => {})
    }
  }, [loggedIn])

  /* ── Provider actions ────────────────────────────────────────────────── */

  function resetForm() {
    setFormLabel('')
    setFormBaseUrl('')
    setFormApiKey('')
    setFormModel('')
    setEditingId(null)
    setShowAddForm(false)
  }

  function openEditForm(p: MobileProvider) {
    setFormLabel(p.label)
    setFormBaseUrl(p.baseUrl)
    setFormApiKey(p.apiKey)
    setFormModel(p.model)
    setEditingId(p.id)
    setShowAddForm(true)
  }

  function handleSaveProvider() {
    if (!formLabel.trim() || !formBaseUrl.trim() || !formApiKey.trim() || !formModel.trim()) return

    let updated: MobileProvider[]
    if (editingId) {
      updated = providers.map((p) =>
        p.id === editingId
          ? { ...p, label: formLabel.trim(), baseUrl: formBaseUrl.trim(), apiKey: formApiKey.trim(), model: formModel.trim() }
          : p,
      )
    } else {
      const np: MobileProvider = {
        id: uid(),
        label: formLabel.trim(),
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim(),
        model: formModel.trim(),
        enabled: true,
      }
      updated = [...providers, np]
      /* auto-set as default if first */
      if (updated.length === 1) {
        setDefaultProviderId(np.id)
        setDefaultId(np.id)
      }
    }
    saveProviders(updated)
    setProviders(updated)
    resetForm()
  }

  function toggleProvider(id: string) {
    const updated = providers.map((p) =>
      p.id === id ? { ...p, enabled: !p.enabled } : p,
    )
    saveProviders(updated)
    setProviders(updated)
  }

  function removeProvider(id: string) {
    const updated = providers.filter((p) => p.id !== id)
    saveProviders(updated)
    setProviders(updated)
    if (defaultId === id) {
      const next = updated.find((p) => p.enabled)?.id ?? null
      if (next) setDefaultProviderId(next)
      setDefaultId(next)
    }
  }

  function makeDefault(id: string) {
    setDefaultProviderId(id)
    setDefaultId(id)
  }

  function saveServerUrl() {
    const trimmed = serverUrl.trim().replace(/\/+$/, '')
    if (!trimmed) return
    setBaseUrl(trimmed)
    setServerUrl(trimmed)
    setUrlSaved(true)
    setTimeout(() => setUrlSaved(false), 2000)
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 py-3">
        <h1 className="text-lg font-bold text-ink">设置</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-28 flex flex-col gap-5">

        {/* ── Account ──────────────────────────────────────────────────── */}
        <Section title="账户">
          <div className="bg-editor rounded-[14px] border border-line divide-y divide-line overflow-hidden">
            {loggedIn ? (
              <>
                <div className="px-4 py-3.5 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-ink-muted font-medium">用户名</p>
                    <p className="text-sm font-semibold text-ink mt-0.5">{username}</p>
                  </div>
                  <div className="w-9 h-9 rounded-full bg-primary text-white text-sm font-bold flex items-center justify-center">
                    {(username || '?')[0].toUpperCase()}
                  </div>
                </div>
                <div className="px-4 py-3.5 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] text-ink-muted font-medium">同步状态</p>
                    <p className={`text-sm font-medium mt-0.5 ${wsColors[wsState] ?? 'text-ink'}`}>
                      {wsLabels[wsState] ?? wsState}
                    </p>
                  </div>
                  <StatusDot state={wsState} />
                </div>
                <div className="px-4 py-2.5">
                  <button
                    onClick={() => logout()}
                    disabled={busy}
                    className="w-full py-2.5 rounded-[10px] text-failed text-sm font-medium active:bg-failed/8 disabled:opacity-50 transition-colors"
                  >
                    {busy ? '退出中...' : '退出登录'}
                  </button>
                </div>
              </>
            ) : (
              <div className="px-4 py-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-ink">未登录</p>
                  <p className="text-xs text-ink-muted mt-0.5">登录以启用多设备同步</p>
                </div>
                <button
                  onClick={openPortal}
                  className="px-4 py-2 rounded-[10px] bg-primary text-white text-sm font-medium active:opacity-90 transition-opacity"
                >
                  登录
                </button>
              </div>
            )}
          </div>
        </Section>

        {/* ── Devices ──────────────────────────────────────────────────── */}
        {loggedIn && devices.length > 0 && (
          <Section title="已连接设备">
            <div className="bg-editor rounded-[14px] border border-line divide-y divide-line overflow-hidden">
              {devices.map((d) => (
                <div key={d.id} className="px-4 py-3.5 flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    d.kind === 'mobile' ? 'bg-running/10' : 'bg-primary/8'
                  }`}>
                    {d.kind === 'mobile' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-running">
                        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                        <line x1="12" y1="18" x2="12.01" y2="18" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{d.name}</p>
                    <p className="text-[11px] text-ink-faint">{d.kind}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── AI Providers ─────────────────────────────────────────────── */}
        <Section title="AI 服务商">
          {providers.length > 0 && (
            <div className="bg-editor rounded-[14px] border border-line divide-y divide-line overflow-hidden mb-3">
              {providers.map((p) => (
                <div key={p.id} className="px-4 py-3.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${p.enabled ? 'bg-done' : 'bg-ink-faint'}`} />
                      <p className="text-sm font-medium text-ink truncate">{p.label}</p>
                      {defaultId === p.id && (
                        <span className="badge-mint text-[10px] px-1.5 py-0.5 rounded-md shrink-0">
                          默认
                        </span>
                      )}
                    </div>
                    {/* Toggle */}
                    <button
                      onClick={() => toggleProvider(p.id)}
                      className={`w-11 h-6 rounded-full relative transition-colors ${
                        p.enabled ? 'bg-done' : 'bg-surface-2'
                      }`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        p.enabled ? 'left-[22px]' : 'left-0.5'
                      }`} />
                    </button>
                  </div>

                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-ink-muted font-mono bg-surface-2 px-1.5 py-0.5 rounded">
                      {p.model}
                    </span>
                    <span className="text-[11px] text-ink-faint font-mono truncate max-w-[140px]">
                      {maskKey(p.apiKey)}
                    </span>
                  </div>

                  <div className="mt-2.5 flex items-center gap-2">
                    {defaultId !== p.id && p.enabled && (
                      <button
                        onClick={() => makeDefault(p.id)}
                        className="text-[11px] text-running font-medium active:opacity-70"
                      >
                        设为默认
                      </button>
                    )}
                    <button
                      onClick={() => openEditForm(p)}
                      className="text-[11px] text-ink-muted font-medium active:opacity-70"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => removeProvider(p.id)}
                      className="text-[11px] text-failed font-medium active:opacity-70"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add / Edit form */}
          {showAddForm ? (
            <div className="bg-editor rounded-[14px] border border-line p-4 flex flex-col gap-3.5 animate-in">
              <p className="text-sm font-semibold text-ink">
                {editingId ? '编辑服务商' : '添加服务商'}
              </p>

              <FieldInput label="名称" placeholder="例如：OpenAI" value={formLabel} onChange={setFormLabel} />
              <FieldInput label="Base URL" placeholder="https://api.openai.com" value={formBaseUrl} onChange={setFormBaseUrl} mono />
              <FieldInput label="API Key" placeholder="sk-..." value={formApiKey} onChange={setFormApiKey} mono type="password" />
              <FieldInput label="模型名称" placeholder="gpt-4o" value={formModel} onChange={setFormModel} mono />

              <div className="flex gap-2 mt-1">
                <button
                  onClick={resetForm}
                  className="flex-1 py-2.5 rounded-[10px] bg-surface-2 text-ink-muted text-sm font-medium active:bg-surface transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveProvider}
                  disabled={!formLabel.trim() || !formBaseUrl.trim() || !formApiKey.trim() || !formModel.trim()}
                  className="flex-1 py-2.5 rounded-[10px] bg-primary text-white text-sm font-medium active:opacity-90 disabled:opacity-40 transition-all"
                >
                  {editingId ? '保存修改' : '添加'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { resetForm(); setShowAddForm(true); }}
              className="w-full py-3 rounded-[14px] border-2 border-dashed border-line text-sm font-medium text-ink-dim active:border-primary active:text-primary transition-colors flex items-center justify-center gap-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加 AI 服务商
            </button>
          )}
        </Section>

        {/* ── Server ───────────────────────────────────────────────────── */}
        <Section title="服务器">
          <div className="bg-editor rounded-[14px] border border-line p-4 flex flex-col gap-3">
            <div>
              <label className="text-[11px] text-ink-muted font-medium block mb-1.5">服务器地址</label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://..."
                  className="flex-1 h-10 px-3 rounded-[10px] border border-line bg-surface text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 transition font-mono"
                />
                <button
                  onClick={saveServerUrl}
                  className={`shrink-0 px-4 h-10 rounded-[10px] text-sm font-medium transition-colors ${
                    urlSaved
                      ? 'bg-done/10 text-done'
                      : 'bg-primary text-white active:opacity-90'
                  }`}
                >
                  {urlSaved ? '已保存' : '保存'}
                </button>
              </div>
              <p className="text-[11px] text-ink-faint mt-1.5">修改后需重新打开应用生效</p>
            </div>
          </div>
        </Section>

        {/* ── About ────────────────────────────────────────────────────── */}
        <Section title="关于">
          <div className="bg-editor rounded-[14px] border border-line divide-y divide-line overflow-hidden">
            <div className="px-4 py-3.5 flex items-center justify-between">
              <p className="text-sm text-ink">应用名称</p>
              <p className="text-sm text-ink-muted">Iris</p>
            </div>
            <div className="px-4 py-3.5 flex items-center justify-between">
              <p className="text-sm text-ink">版本</p>
              <p className="text-sm text-ink-muted font-mono">v0.14.0</p>
            </div>
            <div className="px-4 py-3.5 flex items-center justify-between">
              <p className="text-sm text-ink">平台</p>
              <p className="text-sm text-ink-muted">Capacitor Android</p>
            </div>
            <div className="px-4 py-3.5">
              <p className="text-xs text-ink-faint text-center">
                Copyright 2024-2026. All rights reserved.
              </p>
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}

/* ── Reusable sub-components ──────────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="text-xs font-semibold text-ink-dim uppercase tracking-wider mb-2 px-1">
        {title}
      </p>
      {children}
    </section>
  )
}

function FieldInput({
  label,
  placeholder,
  value,
  onChange,
  mono,
  type = 'text',
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  type?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] text-ink-muted font-medium">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-10 px-3 rounded-[10px] border border-line bg-surface text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 transition ${
          mono ? 'font-mono' : ''
        }`}
      />
    </div>
  )
}
