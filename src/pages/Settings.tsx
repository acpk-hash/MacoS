import { useEffect, useState, useCallback } from 'react'
import {
  useProviderStore,
  type ProviderInfo,
  type ProviderTestResult,
} from '../stores/providerStore'

// ── Tauri invoke helper ───────────────────────────────────────────────────────

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface EngineStatus {
  name: string
  available: boolean
  version: string | null
}

type EngineMode = 'codex-cli' | 'embedded'

/** Mirrors Rust's EmbeddedEngineStatus (embedded_engine_status command). */
interface EmbeddedEngineStatus {
  engine_bin_path: string | null
  engine_bin_found: boolean
  codex_exe_path: string | null
  codex_found: boolean
  codex_error: string | null
}

interface McpServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

interface EngineConfigInfo {
  provider_name: string
  base_url: string
  wire_api: string
  model: string
  model_reasoning_effort: string
  has_api_key: boolean
  key_mask: string
}

interface TestResult {
  success: boolean
  message: string
  elapsed_ms: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh']

// ── Model Service Sub-section ─────────────────────────────────────────────────

const WIRE_API_OPTIONS = ['responses', 'chat']

// ── Providers Section (multi-service model config) ────────────────────────────

/** New wire_api options for user providers (chat is the safe default). */
const PROVIDER_WIRE_API_OPTIONS = ['chat', 'responses']

function ProvidersSection() {
  const { providers, loadProviders, upsert, setKey, remove, test } =
    useProviderStore()
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({
    label: '',
    base_url: '',
    wire_api: 'chat',
    key: '',
  })
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [tests, setTests] = useState<
    Record<string, ProviderTestResult | 'loading'>
  >({})

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  const resetForm = () => {
    setForm({ label: '', base_url: '', wire_api: 'chat', key: '' })
    setEditId(null)
    setShowForm(false)
    setFormError('')
  }

  const startAdd = () => {
    resetForm()
    setShowForm(true)
  }

  const startEdit = (p: ProviderInfo) => {
    setEditId(p.id)
    setForm({ label: p.label, base_url: p.base_url, wire_api: p.wire_api, key: '' })
    setFormError('')
    setShowForm(true)
  }

  const submit = async () => {
    if (!form.label.trim()) {
      setFormError('请填写服务商名称')
      return
    }
    if (!form.base_url.trim()) {
      setFormError('请填写 Base URL')
      return
    }
    setBusy(true)
    setFormError('')
    try {
      const id = await upsert({
        id: editId ?? undefined,
        label: form.label.trim(),
        base_url: form.base_url.trim(),
        wire_api: form.wire_api,
        enabled: true,
      })
      // Only write the key when the user typed one (empty = leave unchanged).
      if (id && form.key.trim()) {
        await setKey(id, form.key.trim())
      }
      resetForm()
    } catch (e) {
      setFormError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (p: ProviderInfo) => {
    try {
      await upsert({
        id: p.id,
        label: p.label,
        base_url: p.base_url,
        wire_api: p.wire_api,
        enabled: !p.enabled,
      })
    } catch (e) {
      console.error('toggle provider failed:', e)
    }
  }

  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'loading' }))
    try {
      const res = await test(id)
      setTests((t) => ({ ...t, [id]: res }))
    } catch (e) {
      setTests((t) => ({
        ...t,
        [id]: { success: false, message: String(e), elapsed_ms: 0 },
      }))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await remove(id)
    } catch (e) {
      console.error('delete provider failed:', e)
    }
    setConfirmDelete(null)
  }

  const inputCls =
    'w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors'

  return (
    <div className="glass rounded-card p-4 space-y-4">
      <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
        模型服务商
      </h3>
      <p className="text-xs text-ink-dim -mt-2 leading-relaxed">
        配置多个 OpenAI 兼容服务商，聊天/生成页的模型下拉将聚合所有已启用服务商的模型。
        <span className="text-ink-muted">
          API Key 仅保存在本机凭据管理器，不会上传。
        </span>
      </p>

      {/* Provider cards */}
      <div className="space-y-2">
        {providers.length === 0 && (
          <p className="text-xs text-ink-dim italic">暂无服务商，点击下方添加</p>
        )}
        {providers.map((p) => {
          const t = tests[p.id]
          return (
            <div
              key={p.id}
              className="bg-surface-2/60 border border-line rounded-lg px-3 py-2.5 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-ink truncate">
                      {p.label}
                    </p>
                    {p.is_default && (
                      <span className="text-[10px] text-sky bg-sakura/40 px-1.5 py-0.5 rounded">
                        默认
                      </span>
                    )}
                    <span className="text-[10px] text-ink-dim bg-elevated/60 px-1.5 py-0.5 rounded">
                      {p.wire_api}
                    </span>
                  </div>
                  <p className="text-xs text-ink-dim truncate">{p.base_url}</p>
                  <p className="text-xs mt-0.5">
                    {p.has_key ? (
                      <span className="text-green-500">
                        Key 已设置（{p.key_mask}）
                      </span>
                    ) : (
                      <span className="text-yellow-500">Key 未设置</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => toggleEnabled(p)}
                  className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                    p.enabled ? 'bg-sakura' : 'bg-elevated'
                  }`}
                  title={p.enabled ? '已启用' : '已禁用'}
                  aria-label="Toggle provider enabled"
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      p.enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <button
                  onClick={() => runTest(p.id)}
                  disabled={t === 'loading'}
                  className="text-sky hover:text-sky disabled:text-ink-dim transition-colors"
                >
                  {t === 'loading' ? '测试中…' : '测试'}
                </button>
                <button
                  onClick={() => startEdit(p)}
                  className="text-ink-muted hover:text-ink transition-colors"
                >
                  编辑
                </button>
                {confirmDelete === p.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-red-600">确认?</span>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="text-red-600 hover:text-red-600"
                    >
                      删除
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="text-ink-dim hover:text-ink-muted"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(p.id)}
                    className="text-ink-dim hover:text-red-600 transition-colors"
                  >
                    删除
                  </button>
                )}
              </div>

              {t && t !== 'loading' && (
                <p
                  className={`text-xs rounded px-2 py-1 break-words ${
                    t.success
                      ? 'bg-green-900/30 text-green-700'
                      : 'bg-red-900/30 text-red-600'
                  }`}
                >
                  {t.message}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* Add / edit form */}
      {showForm ? (
        <div className="bg-surface-2/60 border border-line rounded-lg p-3 space-y-2.5">
          <h4 className="text-xs font-semibold text-ink-muted">
            {editId ? '编辑服务商' : '添加服务商'}
          </h4>
          {formError && <p className="text-xs text-red-600">{formError}</p>}
          <div>
            <label className="block text-xs text-ink-dim mb-1">名称</label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="例如 OpenAI / 我的中继"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs text-ink-dim mb-1">Base URL</label>
            <input
              type="text"
              value={form.base_url}
              onChange={(e) =>
                setForm((f) => ({ ...f, base_url: e.target.value }))
              }
              placeholder="https://api.openai.com"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs text-ink-dim mb-1">Wire API</label>
            <select
              value={form.wire_api}
              onChange={(e) =>
                setForm((f) => ({ ...f, wire_api: e.target.value }))
              }
              className={inputCls}
            >
              {PROVIDER_WIRE_API_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-dim mb-1">
              API Key
              {editId && (
                <span className="text-ink-dim ml-1">（留空=不修改）</span>
              )}
            </label>
            <input
              type="password"
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              placeholder="sk-…"
              autoComplete="new-password"
              className={inputCls}
            />
            <p className="text-xs text-ink-dim mt-0.5">
              仅保存在本机凭据管理器，不入数据库、不上传。
            </p>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={resetForm}
              className="px-3 py-1.5 text-xs text-ink-muted hover:text-ink-muted transition-colors"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-sakura hover:bg-sakura disabled:opacity-40 text-white rounded transition-colors"
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={startAdd}
          className="w-full py-2 border border-dashed border-line hover:border-line-strong rounded-lg text-xs text-ink-dim hover:text-ink-muted transition-colors"
        >
          + 添加服务商
        </button>
      )}
    </div>
  )
}

function ModelServiceSection() {
  const [cfg, setCfg] = useState<EngineConfigInfo | null>(null)
  const [form, setForm] = useState({
    provider_name: '',
    base_url: '',
    wire_api: 'responses',
    model: '',
    model_reasoning_effort: 'xhigh',
    api_key: '',
  })
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const loadCfg = useCallback(async () => {
    try {
      const info = await tauriInvoke<EngineConfigInfo>('engine_config_get')
      setCfg(info)
      setForm((f) => ({
        ...f,
        provider_name: info.provider_name,
        base_url: info.base_url,
        wire_api: info.wire_api,
        model: info.model,
        model_reasoning_effort: info.model_reasoning_effort,
        api_key: '', // never pre-fill; placeholder shows mask
      }))
    } catch (e) {
      console.error('engine_config_get failed:', e)
    }
  }, [])

  useEffect(() => {
    loadCfg()
  }, [loadCfg])

  const handleSave = async () => {
    setSaving(true)
    setSaveResult(null)
    try {
      await tauriInvoke('engine_config_set', {
        cfg: {
          provider_name: form.provider_name,
          base_url: form.base_url,
          wire_api: form.wire_api,
          model: form.model,
          model_reasoning_effort: form.model_reasoning_effort,
          // Empty string → leave auth.json untouched (Rust trims and checks)
          api_key: form.api_key || null,
        },
      })
      // Also sync reasoning_effort to SQLite so agent sessions pick it up.
      await tauriInvoke('settings_set', {
        key: 'reasoning_effort',
        value: form.model_reasoning_effort,
      })
      setSaveResult('已保存')
      // Refresh mask display.
      await loadCfg()
    } catch (e) {
      setSaveResult(`保存失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await tauriInvoke<TestResult>('engine_config_test')
      setTestResult(result)
    } catch (e) {
      setTestResult({ success: false, message: String(e), elapsed_ms: 0 })
    } finally {
      setTesting(false)
    }
  }

  const keyPlaceholder =
    cfg?.has_api_key ? `已设置（${cfg.key_mask}）` : '输入 API Key…'

  return (
    <div className="glass rounded-card p-4 space-y-4">
      <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
        模型服务
      </h3>
      <p className="text-xs text-ink-dim -mt-2">
        写入 <code className="text-ink-muted">~/.codex/config.toml</code> 和{' '}
        <code className="text-ink-muted">auth.json</code>；修改对新会话生效，写入前自动备份。
      </p>

      <div className="space-y-3">
        {/* Provider name */}
        <div>
          <label className="block text-xs text-ink-dim mb-1">服务商名称 (model_provider)</label>
          <input
            type="text"
            value={form.provider_name}
            onChange={(e) => setForm((f) => ({ ...f, provider_name: e.target.value }))}
            placeholder="OpenAI"
            className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        {/* base_url */}
        <div>
          <label className="block text-xs text-ink-dim mb-1">Base URL</label>
          <input
            type="text"
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            placeholder="https://api.openai.com"
            className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        {/* wire_api */}
        <div>
          <label className="block text-xs text-ink-dim mb-1">Wire API</label>
          <select
            value={form.wire_api}
            onChange={(e) => setForm((f) => ({ ...f, wire_api: e.target.value }))}
            className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm
                       text-ink focus:outline-none focus:border-lavender transition-colors"
          >
            {WIRE_API_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        {/* model */}
        <div>
          <label className="block text-xs text-ink-dim mb-1">模型名称 (model)</label>
          <input
            type="text"
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="gpt-5.5"
            className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        {/* reasoning effort — reuses REASONING_EFFORT_OPTIONS, linked to the
            existing "推理深度" dropdown via settings_set on save */}
        <div>
          <label className="block text-xs text-ink-dim mb-1">
            推理力度 (model_reasoning_effort)
          </label>
          <select
            value={form.model_reasoning_effort}
            onChange={(e) =>
              setForm((f) => ({ ...f, model_reasoning_effort: e.target.value }))
            }
            className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm
                       text-ink focus:outline-none focus:border-lavender transition-colors"
          >
            {REASONING_EFFORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <p className="text-xs text-ink-dim mt-0.5">
            保存时同步写入 config.toml 和应用设置
          </p>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs text-ink-dim mb-1">
            API Key{' '}
            {cfg?.has_api_key && (
              <span className="text-green-600 ml-1">（已设置）</span>
            )}
          </label>
          <input
            type="password"
            value={form.api_key}
            onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
            placeholder={keyPlaceholder}
            autoComplete="new-password"
            className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
          <p className="text-xs text-ink-dim mt-0.5">
            留空=不修改；写入 auth.json（无 BOM UTF-8，不入数据库）
          </p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-sakura hover:bg-sakura disabled:opacity-40
                     text-white text-sm rounded-lg transition-colors"
        >
          {saving ? '保存中…' : '保存配置'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="px-4 py-2 bg-elevated hover:bg-elevated disabled:bg-surface-2
                     text-ink text-sm rounded-lg transition-colors"
        >
          {testing ? '测试中…' : '测试连通'}
        </button>
      </div>

      {/* Save result */}
      {saveResult && (
        <p
          className={`text-xs ${
            saveResult.startsWith('保存失败') ? 'text-red-600' : 'text-green-600'
          }`}
        >
          {saveResult}
        </p>
      )}

      {/* Test result */}
      {testResult && (
        <div
          className={`text-xs rounded-lg p-3 font-mono whitespace-pre-wrap break-words ${
            testResult.success
              ? 'bg-green-900/30 text-green-700'
              : 'bg-red-900/30 text-red-600'
          }`}
        >
          {testResult.message}
        </div>
      )}
    </div>
  )
}

// ── Engine Section ────────────────────────────────────────────────────────────

function EngineSection() {
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [detecting, setDetecting] = useState(false)
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [engineMode, setEngineMode] = useState<EngineMode>('codex-cli')
  const [embeddedStatus, setEmbeddedStatus] = useState<EmbeddedEngineStatus | null>(null)
  const [switchingMode, setSwitchingMode] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const all = await tauriInvoke<Record<string, string>>('settings_get_all')
      setSettings(all)
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }, [])

  const detect = useCallback(async () => {
    setDetecting(true)
    try {
      const result = await tauriInvoke<EngineStatus[]>('detect_engines')
      setEngines(result)
    } catch (e) {
      console.error('detect_engines failed:', e)
    } finally {
      setDetecting(false)
    }
  }, [])

  const loadEngineMode = useCallback(async () => {
    try {
      const mode = await tauriInvoke<EngineMode>('engine_mode_get')
      setEngineMode(mode)
    } catch (e) {
      console.error('engine_mode_get failed:', e)
    }
  }, [])

  const loadEmbeddedStatus = useCallback(async () => {
    try {
      const st = await tauriInvoke<EmbeddedEngineStatus>('embedded_engine_status')
      setEmbeddedStatus(st)
    } catch (e) {
      console.error('embedded_engine_status failed:', e)
    }
  }, [])

  const handleEngineModeChange = async (mode: EngineMode) => {
    if (mode === engineMode) return
    setSwitchingMode(true)
    try {
      await tauriInvoke('engine_mode_set', { mode })
      setEngineMode(mode)
      // Refresh embedded readiness whenever the mode changes.
      await loadEmbeddedStatus()
    } catch (e) {
      console.error('engine_mode_set failed:', e)
    } finally {
      setSwitchingMode(false)
    }
  }

  useEffect(() => {
    loadSettings()
    detect()
    loadEngineMode()
    loadEmbeddedStatus()
  }, [detect, loadSettings, loadEngineMode, loadEmbeddedStatus])

  const saveSetting = async (key: string, value: string) => {
    setSaving((s) => ({ ...s, [key]: true }))
    try {
      await tauriInvoke('settings_set', { key, value })
      setSettings((s) => ({ ...s, [key]: value }))
    } catch (e) {
      console.error('settings_set failed:', e)
    } finally {
      setSaving((s) => ({ ...s, [key]: false }))
    }
  }

  const pickWorkdir = async () => {
    try {
      const path = await tauriInvoke<string | null>('pick_directory')
      if (path) {
        await saveSetting('default_workdir', path)
      }
    } catch (e) {
      console.error('pick_directory failed:', e)
    }
  }

  const codexEngine = engines.find((e) => e.name === 'codex')
  const claudeEngine = engines.find((e) => e.name === 'claude')

  const currentPolicy = settings['confirmation_policy'] ?? 'auto'
  const currentEffort = settings['reasoning_effort'] ?? 'low'
  const currentWorkdir = settings['default_workdir'] ?? ''

  return (
    <div className="space-y-5">
      {/* Engine status */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
            引擎状态
          </h3>
          <button
            onClick={detect}
            disabled={detecting}
            className="text-xs text-sky hover:text-sky disabled:text-ink-dim transition-colors"
          >
            {detecting ? '检测中…' : '重新检测'}
          </button>
        </div>

        <div className="space-y-2">
          {/* Codex */}
          <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  codexEngine?.available ? 'bg-green-400' : 'bg-elevated'
                }`}
              />
              <span className="text-sm font-medium text-ink">Codex</span>
            </div>
            <span className="text-xs text-ink-muted">
              {detecting
                ? '…'
                : codexEngine?.available
                  ? codexEngine.version ?? '已安装'
                  : '未安装'}
            </span>
          </div>

          {/* Claude (coming soon) */}
          <div className="flex items-center justify-between bg-surface rounded-lg px-3 py-2.5 opacity-50">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  claudeEngine?.available ? 'bg-green-400' : 'bg-elevated'
                }`}
              />
              <span className="text-sm font-medium text-ink">Claude</span>
            </div>
            <span className="text-xs text-yellow-600 bg-yellow-900/30 px-1.5 py-0.5 rounded">
              即将支持
            </span>
          </div>
        </div>
      </div>

      {/* Agent engine mode (Codex CLI vs embedded engine) */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
          Agent 引擎
        </label>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="agent_engine"
              value="codex-cli"
              checked={engineMode === 'codex-cli'}
              onChange={() => handleEngineModeChange('codex-cli')}
              disabled={switchingMode}
              className="accent-sakura"
            />
            <span className="text-sm text-ink">Codex CLI（需已安装 codex）</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="agent_engine"
              value="embedded"
              checked={engineMode === 'embedded'}
              onChange={() => handleEngineModeChange('embedded')}
              disabled={switchingMode}
              className="accent-sakura"
            />
            <span className="text-sm text-ink">内置引擎（推荐）</span>
          </label>
        </div>
        <p className="text-xs text-ink-dim mt-1.5">
          切换即生效于下次派发的会话；当前正在运行的会话不受影响。
        </p>

        {/* Embedded engine readiness */}
        <div className="mt-3 bg-surface border border-line rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-muted">内置引擎状态</span>
            <button
              onClick={loadEmbeddedStatus}
              className="text-xs text-sky hover:text-sky transition-colors"
            >
              重新检测
            </button>
          </div>

          {/* Engine exe */}
          <div className="flex items-start gap-2">
            <span
              className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                embeddedStatus?.engine_bin_found ? 'bg-green-400' : 'bg-red-500'
              }`}
            />
            <div className="min-w-0">
              <p className="text-xs text-ink-muted">引擎可执行文件</p>
              {embeddedStatus == null ? (
                <p className="text-xs text-ink-dim">检测中…</p>
              ) : embeddedStatus.engine_bin_found ? (
                <p className="text-xs text-ink-dim font-mono break-all">
                  {embeddedStatus.engine_bin_path}
                </p>
              ) : (
                <p className="text-xs text-red-600">
                  未找到 agentboard-engine，请重新安装应用或在设置中指定路径。
                </p>
              )}
            </div>
          </div>

          {/* codex.exe probe */}
          <div className="flex items-start gap-2">
            <span
              className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                embeddedStatus?.codex_found ? 'bg-green-400' : 'bg-yellow-500'
              }`}
            />
            <div className="min-w-0">
              <p className="text-xs text-ink-muted">codex.exe 探测</p>
              {embeddedStatus == null ? (
                <p className="text-xs text-ink-dim">检测中…</p>
              ) : embeddedStatus.codex_found ? (
                <p className="text-xs text-ink-dim font-mono break-all">
                  {embeddedStatus.codex_exe_path}
                </p>
              ) : (
                <p className="text-xs text-yellow-400">
                  {embeddedStatus.codex_error ??
                    '未找到 codex 可执行文件（内置引擎的 exec-server 需要它）。'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Default workdir */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
          默认工作目录
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={currentWorkdir}
            onChange={(e) =>
              setSettings((s) => ({ ...s, default_workdir: e.target.value }))
            }
            onBlur={(e) => {
              if (e.target.value !== settings['default_workdir']) {
                saveSetting('default_workdir', e.target.value)
              }
            }}
            placeholder="选择或输入目录路径…"
            className="flex-1 bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink
                       placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors"
          />
          <button
            onClick={pickWorkdir}
            className="px-3 py-2 bg-elevated hover:bg-elevated text-ink text-sm rounded-lg
                       transition-colors whitespace-nowrap"
          >
            选择目录
          </button>
        </div>
        {currentWorkdir && (
          <p className="text-xs text-ink-dim mt-1">
            新会话/新任务的工作目录默认值
          </p>
        )}
      </div>

      {/* Confirmation policy */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">
          确认策略
        </label>
        <p className="text-xs text-ink-dim mb-2">
          即将生效 — 存储当前策略并在 Chat 页展示徽标，拦截逻辑将在后续版本接入。
        </p>
        <select
          value={currentPolicy}
          onChange={(e) => saveSetting('confirmation_policy', e.target.value)}
          className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                     text-ink focus:outline-none focus:border-lavender transition-colors"
        >
          <option value="auto">自动执行</option>
          <option value="per_file">逐文件批准</option>
        </select>
        {saving['confirmation_policy'] && (
          <p className="text-xs text-ink-dim mt-1">保存中…</p>
        )}
      </div>

      {/* Reasoning effort */}
      <div>
        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
          推理深度 (reasoning effort)
        </label>
        <select
          value={currentEffort}
          onChange={(e) => saveSetting('reasoning_effort', e.target.value)}
          className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                     text-ink focus:outline-none focus:border-lavender transition-colors"
        >
          {REASONING_EFFORT_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-dim mt-1">
          已生效：新 Agent 会话和跟进回复将以 <code className="text-ink-muted">-c model_reasoning_effort={currentEffort}</code> 启动 Codex
        </p>
        {saving['reasoning_effort'] && (
          <p className="text-xs text-sky mt-1">已保存</p>
        )}
      </div>

      {/* Multi-provider model services (SQLite metadata + credential-store keys) */}
      <ProvidersSection />

      {/* Legacy engine config (config.toml + auth.json) — powers the Codex agent path */}
      <ModelServiceSection />
    </div>
  )
}

// ── MCP Section ───────────────────────────────────────────────────────────────

function McpSection() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    command: '',
    argsText: '',
    envText: '',
  })
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadServers = useCallback(async () => {
    setLoading(true)
    try {
      const list = await tauriInvoke<McpServer[]>('mcp_list')
      setServers(list)
    } catch (e) {
      console.error('mcp_list failed:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  const parseEnv = (text: string): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf('=')
      if (idx > 0) {
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
      }
    }
    return env
  }

  const handleAdd = async () => {
    if (!form.name.trim()) {
      setFormError('名称不能为空')
      return
    }
    if (!form.command.trim()) {
      setFormError('命令不能为空')
      return
    }
    setFormError('')
    setSubmitting(true)
    try {
      const args = form.argsText
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const env = parseEnv(form.envText)
      await tauriInvoke('mcp_add', {
        name: form.name.trim(),
        command: form.command.trim(),
        args,
        env,
      })
      setForm({ name: '', command: '', argsText: '', envText: '' })
      setShowAdd(false)
      await loadServers()
    } catch (e) {
      setFormError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemove = async (name: string) => {
    try {
      await tauriInvoke('mcp_remove', { name })
      setConfirmDelete(null)
      await loadServers()
    } catch (e) {
      console.error('mcp_remove failed:', e)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-dim leading-relaxed">
        管理 Codex CLI 的 MCP 服务器配置（
        <code className="text-ink-muted">~/.codex/config.toml</code>）。
        修改对新会话生效，写入前自动备份 config.toml.bak。
      </p>

      {/* Server list */}
      {loading ? (
        <p className="text-xs text-ink-dim">加载中…</p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-ink-dim italic">暂无 MCP 服务器</p>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div
              key={s.name}
              className="bg-surface border border-line rounded-lg px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-ink">{s.name}</p>
                  <p className="text-xs text-ink-dim truncate">
                    {s.command}
                    {s.args.length > 0 && (
                      <span className="text-ink-dim"> {s.args.join(' ')}</span>
                    )}
                  </p>
                  {Object.keys(s.env).length > 0 && (
                    <p className="text-xs text-ink-dim">
                      env: {Object.keys(s.env).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {confirmDelete === s.name ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-600">确认删除?</span>
                      <button
                        onClick={() => handleRemove(s.name)}
                        className="text-xs text-red-600 hover:text-red-600"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="text-xs text-ink-dim hover:text-ink-muted"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(s.name)}
                      className="text-xs text-ink-dim hover:text-red-600 transition-colors"
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add server form */}
      {showAdd ? (
        <div className="bg-surface border border-line rounded-lg p-3 space-y-3">
          <h4 className="text-xs font-semibold text-ink-muted">添加 MCP 服务器</h4>
          {formError && (
            <p className="text-xs text-red-600">{formError}</p>
          )}
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-ink-dim mb-1">名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="my-mcp-server"
                className="w-full bg-surface-2 border border-line rounded px-2 py-1.5 text-xs
                           text-ink placeholder-ink-dim focus:outline-none focus:border-lavender"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-dim mb-1">命令</label>
              <input
                type="text"
                value={form.command}
                onChange={(e) =>
                  setForm((f) => ({ ...f, command: e.target.value }))
                }
                placeholder="npx"
                className="w-full bg-surface-2 border border-line rounded px-2 py-1.5 text-xs
                           text-ink placeholder-ink-dim focus:outline-none focus:border-lavender"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-dim mb-1">
                参数（空格分隔）
              </label>
              <input
                type="text"
                value={form.argsText}
                onChange={(e) =>
                  setForm((f) => ({ ...f, argsText: e.target.value }))
                }
                placeholder="-y @modelcontextprotocol/server-fetch"
                className="w-full bg-surface-2 border border-line rounded px-2 py-1.5 text-xs
                           text-ink placeholder-ink-dim focus:outline-none focus:border-lavender"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-dim mb-1">
                环境变量（每行 KEY=VALUE）
              </label>
              <textarea
                value={form.envText}
                onChange={(e) =>
                  setForm((f) => ({ ...f, envText: e.target.value }))
                }
                rows={3}
                placeholder="API_KEY=xxx"
                className="w-full bg-surface-2 border border-line rounded px-2 py-1.5 text-xs
                           text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                           resize-none"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setShowAdd(false)
                setFormError('')
              }}
              className="px-3 py-1.5 text-xs text-ink-muted hover:text-ink-muted transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={submitting}
              className="px-3 py-1.5 text-xs bg-sakura hover:bg-sakura disabled:opacity-40
                         text-white rounded transition-colors"
            >
              {submitting ? '添加中…' : '添加'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full py-2 border border-dashed border-line hover:border-line-strong
                     rounded-lg text-xs text-ink-dim hover:text-ink-muted transition-colors"
        >
          + 添加 MCP 服务器
        </button>
      )}
    </div>
  )
}

// ── Bridge status type ────────────────────────────────────────────────────────

interface BridgeStatusInfo {
  state: 'running' | 'stopped' | 'error'
  message: string
  port: number
  logs: string[]
}

// ── Feishu Section ────────────────────────────────────────────────────────────

function FeishuSection() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [showGuide, setShowGuide] = useState(false)

  // Bridge sub-block state
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatusInfo>({
    state: 'stopped',
    message: '',
    port: 0,
    logs: [],
  })
  const [bridgeStarting, setBridgeStarting] = useState(false)
  const [bridgeStopping, setBridgeStopping] = useState(false)
  const [showBridgeLogs, setShowBridgeLogs] = useState(false)
  const [nodeVersion, setNodeVersion] = useState<string | null | undefined>(undefined) // undefined=loading

  const loadSettings = useCallback(async () => {
    try {
      const all = await tauriInvoke<Record<string, string>>('settings_get_all')
      setSettings(all)
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }, [])

  const loadBridgeStatus = useCallback(async () => {
    try {
      const info = await tauriInvoke<BridgeStatusInfo>('bridge_status')
      setBridgeStatus(info)
    } catch (e) {
      console.error('bridge_status failed:', e)
    }
  }, [])

  useEffect(() => {
    loadSettings()
    loadBridgeStatus()
    tauriInvoke<string | null>('bridge_node_version').then(setNodeVersion).catch(() => setNodeVersion(null))
    // Poll bridge status every 5 seconds.
    const timer = setInterval(loadBridgeStatus, 5000)
    return () => clearInterval(timer)
  }, [loadSettings, loadBridgeStatus])

  const saveSetting = async (key: string, value: string) => {
    try {
      await tauriInvoke('settings_set', { key, value })
      setSettings((s) => ({ ...s, [key]: value }))
    } catch (e) {
      console.error('settings_set failed:', e)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const msg = await tauriInvoke<string>('feishu_test')
      setTestResult(`成功：${msg}`)
    } catch (e) {
      setTestResult(`失败：${String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  const loadLogs = async () => {
    try {
      const ls = await tauriInvoke<string[]>('feishu_recent_logs')
      setLogs(ls)
    } catch (e) {
      console.error('feishu_recent_logs failed:', e)
    }
    setShowLogs(true)
  }

  const handleBridgeStart = async () => {
    setBridgeStarting(true)
    try {
      await tauriInvoke('bridge_start')
      await loadBridgeStatus()
    } catch (e) {
      console.error('bridge_start failed:', e)
    } finally {
      setBridgeStarting(false)
    }
  }

  const handleBridgeStop = async () => {
    setBridgeStopping(true)
    try {
      await tauriInvoke('bridge_stop')
      await loadBridgeStatus()
    } catch (e) {
      console.error('bridge_stop failed:', e)
    } finally {
      setBridgeStopping(false)
    }
  }

  const enabled = settings['feishu_enabled'] === 'true'
  const bridgeAutostart = settings['bridge_autostart'] === 'true'

  return (
    <div className="space-y-5">
      {/* 开关 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-ink">启用飞书推送</p>
          <p className="text-xs text-ink-dim mt-0.5">
            任务完成或失败时向指定用户发送交互卡片
          </p>
        </div>
        <button
          onClick={() => saveSetting('feishu_enabled', enabled ? 'false' : 'true')}
          className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${
            enabled ? 'bg-sakura' : 'bg-elevated'
          }`}
          aria-label="Toggle Feishu notifications"
        >
          <span
            className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Config fields */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-ink-dim mb-1">App ID</label>
          <input
            type="text"
            value={settings['feishu_app_id'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, feishu_app_id: e.target.value }))
            }
            onBlur={(e) => saveSetting('feishu_app_id', e.target.value)}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">App Secret</label>
          <input
            type="password"
            value={settings['feishu_app_secret'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, feishu_app_secret: e.target.value }))
            }
            onBlur={(e) => saveSetting('feishu_app_secret', e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">接收者 ID 类型</label>
          <select
            value={settings['feishu_receive_id_type'] ?? 'open_id'}
            onChange={(e) => saveSetting('feishu_receive_id_type', e.target.value)}
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink focus:outline-none focus:border-lavender transition-colors"
          >
            <option value="open_id">open_id（个人）</option>
            <option value="chat_id">chat_id（群组）</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">接收者 ID</label>
          <input
            type="text"
            value={settings['feishu_receive_id'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, feishu_receive_id: e.target.value }))
            }
            onBlur={(e) => saveSetting('feishu_receive_id', e.target.value)}
            placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>
      </div>

      {/* Test button */}
      <div>
        <button
          onClick={sendTest}
          disabled={testing}
          className="px-4 py-2 bg-sakura hover:bg-sakura disabled:opacity-40 text-white
                     text-sm rounded-lg transition-colors"
        >
          {testing ? '发送中…' : '发送测试卡片'}
        </button>
        {testResult && (
          <p
            className={`text-xs mt-2 ${
              testResult.startsWith('成功') ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {testResult}
          </p>
        )}
      </div>

      {/* Recent logs */}
      <div>
        <button
          onClick={showLogs ? () => setShowLogs(false) : loadLogs}
          className="text-xs text-sky hover:text-sky transition-colors"
        >
          {showLogs ? '收起推送日志 ▲' : '最近推送日志 ▼'}
        </button>
        {showLogs && (
          <div className="mt-2 bg-surface rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
            {logs.length === 0 ? (
              <p className="text-xs text-ink-dim italic">暂无日志</p>
            ) : (
              logs.map((entry, i) => (
                <p
                  key={i}
                  className={`text-xs font-mono ${
                    entry.includes('ERR') ? 'text-red-600' : 'text-green-600'
                  }`}
                >
                  {entry}
                </p>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── 指派通道（长连接）sub-block ─────────────────────────────────── */}
      <div className="glass rounded-card p-4 space-y-4">
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
          指派通道（长连接）
        </h3>
        <p className="text-xs text-ink-dim -mt-2 leading-relaxed">
          手机给飞书机器人发一句话 → 桌面端自动建 todo 任务卡并回复确认卡片。
          需本机安装 Node.js；飞书应用需订阅{' '}
          <code className="text-ink-muted">im.message.receive_v1</code> 并启用长连接模式。
        </p>

        {/* Node detection */}
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              nodeVersion ? 'bg-green-400' : nodeVersion === null ? 'bg-red-500' : 'bg-elevated'
            }`}
          />
          <span className="text-xs text-ink-muted">
            {nodeVersion === undefined
              ? 'Node 检测中…'
              : nodeVersion
                ? `Node ${nodeVersion}`
                : 'Node 未安装 — 请先安装 Node.js'}
          </span>
        </div>

        {/* Auto-start toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-ink-muted">应用启动时自动开启</p>
            <p className="text-xs text-ink-dim mt-0.5">需同时启用飞书推送且已配置凭据</p>
          </div>
          <button
            onClick={() => saveSetting('bridge_autostart', bridgeAutostart ? 'false' : 'true')}
            className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none ${
              bridgeAutostart ? 'bg-sakura' : 'bg-elevated'
            }`}
            aria-label="Toggle bridge autostart"
          >
            <span
              className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                bridgeAutostart ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
              bridgeStatus.state === 'running'
                ? 'bg-green-900/40 text-green-700'
                : bridgeStatus.state === 'error'
                  ? 'bg-red-900/40 text-red-600'
                  : 'bg-surface-2 text-ink-dim'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                bridgeStatus.state === 'running'
                  ? 'bg-green-400'
                  : bridgeStatus.state === 'error'
                    ? 'bg-red-400'
                    : 'bg-elevated'
              }`}
            />
            {bridgeStatus.state === 'running'
              ? `运行中 (端口 ${bridgeStatus.port})`
              : bridgeStatus.state === 'error'
                ? '错误'
                : '已停止'}
          </span>
          {bridgeStatus.state === 'error' && bridgeStatus.message && (
            <span className="text-xs text-red-600 truncate">{bridgeStatus.message}</span>
          )}
        </div>

        {/* Start / Stop buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleBridgeStart}
            disabled={bridgeStarting || bridgeStopping || !nodeVersion}
            className="px-3 py-1.5 bg-sakura hover:bg-sakura disabled:opacity-40
                       disabled:text-ink-dim text-white text-xs rounded-lg transition-colors"
            title={!nodeVersion ? '需要先安装 Node.js' : undefined}
          >
            {bridgeStarting ? '启动中…' : '启动'}
          </button>
          <button
            onClick={handleBridgeStop}
            disabled={bridgeStopping || bridgeStarting || bridgeStatus.state === 'stopped'}
            className="px-3 py-1.5 bg-elevated hover:bg-elevated disabled:bg-surface-2
                       disabled:text-ink-dim text-ink text-xs rounded-lg transition-colors"
          >
            {bridgeStopping ? '停止中…' : '停止'}
          </button>
          <button
            onClick={loadBridgeStatus}
            className="px-3 py-1.5 text-xs text-ink-dim hover:text-ink-muted transition-colors"
          >
            刷新
          </button>
        </div>

        {/* Sidecar log (collapsible) */}
        <div>
          <button
            onClick={() => setShowBridgeLogs((v) => !v)}
            className="text-xs text-sky hover:text-sky transition-colors"
          >
            {showBridgeLogs ? 'Sidecar 日志 ▲' : 'Sidecar 日志 ▼'}
          </button>
          {showBridgeLogs && (
            <div className="mt-2 bg-bg rounded-lg p-3 space-y-0.5 max-h-40 overflow-y-auto">
              {bridgeStatus.logs.length === 0 ? (
                <p className="text-xs text-ink-dim italic">暂无日志</p>
              ) : (
                bridgeStatus.logs.map((entry, i) => (
                  <p
                    key={i}
                    className={`text-xs font-mono leading-relaxed ${
                      entry.includes('[ERR]') || entry.includes('[err]')
                        ? 'text-red-600'
                        : entry.includes('[WARN]')
                          ? 'text-yellow-400'
                          : 'text-ink-muted'
                    }`}
                  >
                    {entry}
                  </p>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Setup guide (collapsible) */}
      <div>
        <button
          onClick={() => setShowGuide(!showGuide)}
          className="text-xs text-ink-dim hover:text-ink-muted transition-colors"
        >
          {showGuide ? '收起配置指引 ▲' : '如何配置 ▼'}
        </button>
        {showGuide && (
          <div className="mt-2 bg-surface rounded-lg p-3 text-xs text-ink-muted space-y-2 leading-relaxed">
            <p>
              1. 打开{' '}
              <code className="text-ink-muted">open.feishu.cn</code> →
              开发者后台 → 创建企业自建应用
            </p>
            <p>2. 应用能力里开启「机器人」</p>
            <p>
              3. 权限管理开通{' '}
              <code className="text-ink-muted">im:message</code>
              （获取与发送单聊、群组消息）并发布版本
            </p>
            <p>
              4. 凭证与基础信息页复制 App ID 和 App Secret 填到这里
            </p>
            <p>
              5. receive_id 填你自己的 open_id（可在飞书管理后台或通过给机器人发消息后从事件日志获取），类型选 open_id
            </p>
            <p>
              6. 指派通道：开发者后台 → 事件与回调 → 长连接模式：启用；
              订阅 <code className="text-ink-muted">im.message.receive_v1</code> 事件
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Skills Section (static) ───────────────────────────────────────────────────

function SkillsSection() {
  const placeholders = [
    { name: '深度研究', desc: '多源检索、事实核查、综合报告' },
    { name: '代码审查', desc: '安全、性能、可维护性全面评估' },
    { name: '自动调度', desc: '定时执行任务，无需人工干预' },
  ]

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-dim leading-relaxed">
        浏览并启用预置技能，快速赋能 Agent 工作流。Skills 功能即将上线。
      </p>
      {placeholders.map((p) => (
        <div
          key={p.name}
          className="bg-surface border border-line/50 rounded-lg px-3 py-3 opacity-50"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-ink-muted">{p.name}</p>
              <p className="text-xs text-ink-dim mt-0.5">{p.desc}</p>
            </div>
            <span className="text-xs text-yellow-600 bg-yellow-900/30 px-1.5 py-0.5 rounded">
              即将上线
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Agent Market Section (static) ─────────────────────────────────────────────

function AgentMarketSection() {
  const cards = [
    { name: 'PR 审查机器人', org: '社区精选' },
    { name: '文档生成器', org: '官方' },
    { name: '数据分析师', org: '社区精选' },
  ]

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-dim leading-relaxed">
        从社区市场安装预构建 Agent，一键部署到本地看板，开箱即用。Agent 市场即将上线。
      </p>
      <div className="grid grid-cols-1 gap-2">
        {cards.map((c) => (
          <div
            key={c.name}
            className="bg-surface border border-line/50 rounded-lg px-3 py-3 opacity-50"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink-muted">{c.name}</p>
                <p className="text-xs text-ink-dim mt-0.5">{c.org}</p>
              </div>
              <span className="text-xs text-yellow-600 bg-yellow-900/30 px-1.5 py-0.5 rounded">
                敬请期待
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── WeChat Work Section ───────────────────────────────────────────────────────

function WecomSection() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [showGuide, setShowGuide] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const all = await tauriInvoke<Record<string, string>>('settings_get_all')
      setSettings(all)
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const saveSetting = async (key: string, value: string) => {
    try {
      await tauriInvoke('settings_set', { key, value })
      setSettings((s) => ({ ...s, [key]: value }))
    } catch (e) {
      console.error('settings_set failed:', e)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const msg = await tauriInvoke<string>('wecom_test')
      setTestResult(`成功：${msg}`)
    } catch (e) {
      setTestResult(`失败：${String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  const loadLogs = async () => {
    try {
      const ls = await tauriInvoke<string[]>('wecom_recent_logs')
      setLogs(ls)
    } catch (e) {
      console.error('wecom_recent_logs failed:', e)
    }
    setShowLogs(true)
  }

  const enabled = settings['wecom_enabled'] === 'true'
  const qrUrl = settings['wecom_qr_url']?.trim() ?? ''

  return (
    <div className="space-y-5">
      {/* 开关 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-ink">启用企业微信推送</p>
          <p className="text-xs text-ink-dim mt-0.5">
            任务完成或失败时向个人微信发送通知（需先扫码关注）
          </p>
        </div>
        <button
          onClick={() => saveSetting('wecom_enabled', enabled ? 'false' : 'true')}
          className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${
            enabled ? 'bg-sakura' : 'bg-elevated'
          }`}
          aria-label="Toggle WeChat Work notifications"
        >
          <span
            className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Config fields */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-ink-dim mb-1">企业ID (corpid)</label>
          <input
            type="text"
            value={settings['wecom_corpid'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_corpid: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_corpid', e.target.value)}
            placeholder="ww_xxxxxxxxxxxxxxxx"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">应用 Secret (corpsecret)</label>
          <input
            type="password"
            value={settings['wecom_corpsecret'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_corpsecret: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_corpsecret', e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">AgentId</label>
          <input
            type="text"
            value={settings['wecom_agentid'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_agentid: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_agentid', e.target.value)}
            placeholder="1000002"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">
            接收者 (touser)
            <span className="ml-1 text-ink-dim">— 默认 @all</span>
          </label>
          <input
            type="text"
            value={settings['wecom_touser'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_touser: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_touser', e.target.value)}
            placeholder="@all 或成员账号"
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">
            微信插件二维码链接 (wecom_qr_url)
            <span className="ml-1 text-ink-dim">— 可选</span>
          </label>
          <input
            type="text"
            value={settings['wecom_qr_url'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_qr_url: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_qr_url', e.target.value)}
            placeholder="https://..."
            className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                       text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                       transition-colors"
          />
        </div>
      </div>

      {/* QR code display */}
      <div className="bg-surface border border-line rounded-lg p-4">
        <p className="text-xs text-ink-dim mb-3">
          微信插件二维码 — 成员扫码后应用消息直达个人微信
        </p>
        {qrUrl ? (
          <img
            src={qrUrl}
            alt="企业微信微信插件二维码"
            className="w-40 h-40 object-contain rounded-lg border border-line"
          />
        ) : (
          <p className="text-xs text-ink-dim italic leading-relaxed">
            在企业微信管理后台 → 我的企业 → 微信插件 页面获取邀请二维码链接，填入上方字段后此处将显示二维码。
          </p>
        )}
      </div>

      {/* Test button */}
      <div>
        <button
          onClick={sendTest}
          disabled={testing}
          className="px-4 py-2 bg-sakura hover:bg-sakura disabled:opacity-40 text-white
                     text-sm rounded-lg transition-colors"
        >
          {testing ? '发送中…' : '发送测试消息'}
        </button>
        {testResult && (
          <p
            className={`text-xs mt-2 ${
              testResult.startsWith('成功') ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {testResult}
          </p>
        )}
      </div>

      {/* Recent logs */}
      <div>
        <button
          onClick={showLogs ? () => setShowLogs(false) : loadLogs}
          className="text-xs text-sky hover:text-sky transition-colors"
        >
          {showLogs ? '收起推送日志 ▲' : '最近推送日志 ▼'}
        </button>
        {showLogs && (
          <div className="mt-2 bg-surface rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
            {logs.length === 0 ? (
              <p className="text-xs text-ink-dim italic">暂无日志</p>
            ) : (
              logs.map((entry, i) => (
                <p
                  key={i}
                  className={`text-xs font-mono ${
                    entry.includes('ERR') ? 'text-red-600' : 'text-green-600'
                  }`}
                >
                  {entry}
                </p>
              ))
            )}
          </div>
        )}
      </div>

      {/* Setup guide (collapsible) */}
      <div>
        <button
          onClick={() => setShowGuide(!showGuide)}
          className="text-xs text-ink-dim hover:text-ink-muted transition-colors"
        >
          {showGuide ? '收起配置指引 ▲' : '如何配置 ▼'}
        </button>
        {showGuide && (
          <div className="mt-2 bg-surface rounded-lg p-3 text-xs text-ink-muted space-y-2 leading-relaxed">
            <p>
              1. 前往{' '}
              <code className="text-ink-muted">qy.weixin.qq.com</code>{' '}
              注册企业微信（个人也可注册，免认证）
            </p>
            <p>
              2. 管理后台 → 应用管理 → 创建自建应用，记下{' '}
              <code className="text-ink-muted">AgentId</code> 和{' '}
              <code className="text-ink-muted">Secret</code>
            </p>
            <p>
              3. 管理后台 → 我的企业，记下{' '}
              <code className="text-ink-muted">企业ID (corpid)</code>，填入上方
            </p>
            <p>
              4. 管理后台 → 我的企业 → 微信插件：开启后让成员用个人微信扫码关注，
              之后应用消息可直达个人微信。将二维码图片链接填入上方"二维码链接"字段
            </p>
            <p>
              5. 应用详情页 → 企业可信IP：添加本机的公网出口 IP（企业微信 API 要求）；
              发送报错 60020 时按提示添加
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Mobile Sync Section (A3) ──────────────────────────────────────────────────

interface SyncDeviceInfo {
  id: string
  kind: string
  name: string
}

interface SyncStatusInfo {
  enabled: boolean
  logged_in: boolean
  /** disabled | disconnected | connecting | connected | reconnecting */
  state: string
  username: string | null
  device_count: number
  devices: SyncDeviceInfo[]
  last_error: string | null
}

function SyncSection() {
  const [status, setStatus] = useState<SyncStatusInfo | null>(null)
  const [form, setForm] = useState({ username: '', password: '' })
  const [submitting, setSubmitting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const info = await tauriInvoke<SyncStatusInfo>('sync_status')
      setStatus(info)
    } catch (e) {
      console.error('sync_status failed:', e)
    }
  }, [])

  useEffect(() => {
    loadStatus()
    const timer = setInterval(loadStatus, 3000)
    return () => clearInterval(timer)
  }, [loadStatus])

  const doAuth = async (register: boolean) => {
    if (!form.username.trim() || !form.password) {
      setActionError('请输入用户名和密码')
      return
    }
    setSubmitting(true)
    setActionError(null)
    try {
      await tauriInvoke(register ? 'sync_register' : 'sync_login', {
        username: form.username.trim(),
        password: form.password,
      })
      setForm({ username: '', password: '' })
      await loadStatus()
    } catch (e) {
      setActionError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const doLogout = async () => {
    setSubmitting(true)
    setActionError(null)
    try {
      await tauriInvoke('sync_logout')
      await loadStatus()
    } catch (e) {
      setActionError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const toggleEnabled = async () => {
    if (!status) return
    setToggling(true)
    try {
      await tauriInvoke('sync_set_enabled', { enabled: !status.enabled })
      await loadStatus()
    } catch (e) {
      console.error('sync_set_enabled failed:', e)
    } finally {
      setToggling(false)
    }
  }

  const state = status?.state ?? 'disabled'
  const dotClass =
    state === 'connected'
      ? 'bg-green-400'
      : state === 'connecting' || state === 'reconnecting'
        ? 'bg-yellow-400'
        : 'bg-elevated'
  const stateLabel =
    state === 'connected'
      ? '已连接'
      : state === 'connecting'
        ? '连接中…'
        : state === 'reconnecting'
          ? '重连中…'
          : state === 'disconnected'
            ? '未连接'
            : '未启用'

  const kindLabel = (k: string) =>
    k === 'desktop' ? '桌面端' : k === 'mobile' ? '手机' : k || '设备'

  return (
    <div className="space-y-5">
      {/* Data-scope notice */}
      <div className="bg-primary-tint border border-lavender/40 rounded-lg p-3">
        <p className="text-xs text-sky/90 leading-relaxed">
          同步任务、进度与对话内容到你的手机；对话正文会同步（API 密钥绝不上传，附件仅同步文本与文件名、大图不上传）。
        </p>
      </div>

      {status?.logged_in ? (
        // ── Logged in ────────────────────────────────────────────────────────
        <div className="space-y-4">
          {/* Account + connection */}
          <div className="bg-surface border border-line rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-xs text-ink-dim">账号</p>
                <p className="text-sm font-medium text-ink truncate">
                  {status.username ?? '—'}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-surface-2 text-ink-muted">
                <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                {stateLabel}
              </span>
            </div>

            {/* Sync switch */}
            <div className="flex items-center justify-between pt-1 border-t border-line">
              <div>
                <p className="text-sm font-medium text-ink">启用同步</p>
                <p className="text-xs text-ink-dim mt-0.5">
                  关闭后停止推送并断开长连接
                </p>
              </div>
              <button
                onClick={toggleEnabled}
                disabled={toggling}
                className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${
                  status.enabled ? 'bg-sakura' : 'bg-elevated'
                }`}
                aria-label="Toggle mobile sync"
              >
                <span
                  className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    status.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {status.last_error && state !== 'connected' && (
              <p className="text-xs text-red-600 break-words">{status.last_error}</p>
            )}
          </div>

          {/* Device list */}
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
              已登录设备（{status.device_count}）
            </p>
            {status.devices.length === 0 ? (
              <p className="text-xs text-ink-dim italic">
                暂无其他设备。在手机上安装 AgentBoard App 并登录同一账号即可实时查看。
              </p>
            ) : (
              <div className="space-y-1.5">
                {status.devices.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between bg-surface rounded-lg px-3 py-2"
                  >
                    <span className="text-sm text-ink truncate">{d.name || '未命名设备'}</span>
                    <span className="text-xs text-ink-dim bg-surface-2 px-1.5 py-0.5 rounded flex-shrink-0">
                      {kindLabel(d.kind)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Guidance */}
          <div className="bg-surface rounded-lg p-3">
            <p className="text-xs text-ink-muted leading-relaxed">
              在手机上安装 AgentBoard App 并登录同一账号，即可实时查看任务进度并远程派发。
            </p>
          </div>

          {/* Logout */}
          <button
            onClick={doLogout}
            disabled={submitting}
            className="px-4 py-2 bg-elevated hover:bg-elevated disabled:bg-surface-2
                       text-ink text-sm rounded-lg transition-colors"
          >
            {submitting ? '处理中…' : '退出登录'}
          </button>
          {actionError && <p className="text-xs text-red-600">{actionError}</p>}
        </div>
      ) : (
        // ── Logged out ───────────────────────────────────────────────────────
        <div className="space-y-4">
          <p className="text-xs text-ink-dim leading-relaxed">
            使用官方同步服务器登录后，桌面端会把任务与进度实时推送到你的手机。
            服务器地址固定为官方服务器，后续版本再开放自建。
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-ink-dim mb-1">用户名</label>
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="3-32 位（字母/数字/_.-）"
                autoComplete="username"
                className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                           text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                           transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-dim mb-1">密码</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="至少 8 位"
                autoComplete="current-password"
                className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm
                           text-ink placeholder-ink-dim focus:outline-none focus:border-lavender
                           transition-colors"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => doAuth(true)}
              disabled={submitting}
              className="px-4 py-2 bg-sakura hover:bg-sakura disabled:opacity-40
                         text-white text-sm rounded-lg transition-colors"
            >
              {submitting ? '处理中…' : '注册并登录'}
            </button>
            <button
              onClick={() => doAuth(false)}
              disabled={submitting}
              className="px-4 py-2 bg-elevated hover:bg-elevated disabled:bg-surface-2
                         text-ink text-sm rounded-lg transition-colors"
            >
              {submitting ? '处理中…' : '登录'}
            </button>
          </div>
          {actionError && <p className="text-xs text-red-600 break-words">{actionError}</p>}
        </div>
      )}
    </div>
  )
}

// ── Settings page ─────────────────────────────────────────────────────────────

type SectionId = 'engine' | 'mcp' | 'sync' | 'feishu' | 'wecom' | 'skills' | 'market'

interface Section {
  id: SectionId
  title: string
  description: string
}

const SECTIONS: Section[] = [
  {
    id: 'engine',
    title: '推理引擎',
    description: '配置默认引擎、工作目录、推理深度与确认策略。',
  },
  {
    id: 'mcp',
    title: 'MCP 工具',
    description: '管理 Model Context Protocol 工具连接，扩展 Agent 能力。',
  },
  {
    id: 'sync',
    title: '手机同步',
    description: '登录账号后将任务与进度实时推送到手机，并可远程派发任务。聊天原文与密钥永不上传。',
  },
  {
    id: 'feishu',
    title: '手机通知（飞书）',
    description: '任务完成或失败时向飞书账号推送交互卡片通知。',
  },
  {
    id: 'wecom',
    title: '微信通知（企业微信）',
    description: '任务完成或失败时通过企业微信应用消息直达个人微信，需先扫码关注微信插件。',
  },
  {
    id: 'skills',
    title: 'Skills 技能库',
    description: '浏览并启用预置技能，快速赋能 Agent 工作流。',
  },
  {
    id: 'market',
    title: 'Agent 市场',
    description: '从社区市场安装预构建 Agent，一键部署到本地看板。',
  },
]

export default function Settings() {
  const [activeSection, setActiveSection] = useState<SectionId | null>(null)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          {activeSection && (
            <button
              onClick={() => setActiveSection(null)}
              className="text-ink-dim hover:text-ink-muted text-xs transition-colors"
            >
              ← 返回
            </button>
          )}
          <div>
            <h1 className="text-lg font-bold text-gradient">
              {activeSection
                ? SECTIONS.find((s) => s.id === activeSection)?.title ?? '设置'
                : '设置'}
            </h1>
            {!activeSection && (
              <p className="text-xs text-ink-dim mt-0.5">配置引擎、工具与技能</p>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeSection === null ? (
          // Section index
          <div className="space-y-3">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className="w-full text-left glass rounded-card p-4 transition-all duration-150 hover:-translate-y-0.5 hover:border-line-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold text-ink">
                      {section.title}
                    </h2>
                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                      {section.description}
                    </p>
                  </div>
                  <span className="flex-shrink-0 text-ink-dim text-xs mt-0.5">→</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          // Active section content
          <div>
            {activeSection === 'engine' && <EngineSection />}
            {activeSection === 'mcp' && <McpSection />}
            {activeSection === 'sync' && <SyncSection />}
            {activeSection === 'feishu' && <FeishuSection />}
            {activeSection === 'wecom' && <WecomSection />}
            {activeSection === 'skills' && <SkillsSection />}
            {activeSection === 'market' && <AgentMarketSection />}
          </div>
        )}
      </div>
    </div>
  )
}
