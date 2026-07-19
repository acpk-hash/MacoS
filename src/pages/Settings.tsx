import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  useProviderStore,
  type ProviderInfo,
  type ProviderModelsStatus,
  type ProviderTestResult,
} from '../stores/providerStore'
import { useAuthStore } from '../stores/authStore'
import { QRCodeSVG } from 'qrcode.react'
import { createPairingPayload, encodePairingPayload, initializeRemoteRootKey } from '../lib/e2ee'

// ── Tauri invoke helper ───────────────────────────────────────────────────────

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mirrors Rust's PiRuntimeStatus / PiEngineStatusInfo (pi_engine_status). */
interface PiRuntimeStatus {
  found: boolean
  source: string
  path: string | null
  version: string | null
}

interface PiEngineStatusInfo {
  node: PiRuntimeStatus
  pi: PiRuntimeStatus
  bundled: boolean
}

/** pi_engine_status 的 source 三级定位 → 展示文案。 */
const SOURCE_LABEL: Record<string, string> = {
  settings: '自定义路径',
  resource: '应用内置',
  PATH: '系统 PATH',
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
  const {
    providers,
    loaded,
    status,
    statusLoading,
    statusLoaded,
    loadProviders,
    loadStatus,
    upsert,
    setKey,
    remove,
    test,
  } = useProviderStore()
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
    loadStatus()
  }, [loadProviders, loadStatus])

  // 首次运行（没有任何服务商）时自动展开添加表单，省一次点击。
  useEffect(() => {
    if (loaded && providers.length === 0) setShowForm(true)
  }, [loaded, providers.length])

  /** provider_id -> 健康状态（模型数 / 错误原文）。仅覆盖已启用的服务商。 */
  const statusById = useMemo(() => {
    const m: Record<string, ProviderModelsStatus> = {}
    for (const st of status) m[st.provider_id] = st
    return m
  }, [status])

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

  /** 保存表单；testAfter 时保存后立即连通测试并刷新健康状态。 */
  const submit = async (testAfter: boolean) => {
    if (!form.label.trim()) {
      setFormError('请填写服务商名称')
      return
    }
    if (!form.base_url.trim()) {
      setFormError('请填写 Base URL')
      return
    }
    if (!editId && testAfter && !form.key.trim()) {
      setFormError('测试连接需要先填写 API Key')
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
      if (id && testAfter) await runTest(id)
      // 后端在服务商变更时会失效模型缓存，这里刷新即拿到最新健康状态。
      void loadStatus()
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
      void loadStatus()
    } catch (e) {
      console.error('toggle provider failed:', e)
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
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
          模型服务商
        </h3>
        <button
          onClick={() => void loadStatus()}
          disabled={statusLoading}
          className="text-xs text-sky hover:text-sky disabled:text-ink-dim transition-colors"
        >
          {statusLoading ? '检查中…' : '刷新状态'}
        </button>
      </div>
      <p className="text-xs text-ink-dim -mt-2 leading-relaxed">
        配置多个 OpenAI 兼容服务商，聊天/生成/工作台的模型下拉将聚合所有已启用服务商的模型。
        <span className="text-ink-muted">
          API Key 仅保存在本机凭据管理器，不会上传。
        </span>
      </p>

      {/* First-run guide */}
      {loaded && providers.length === 0 && (
        <div className="bg-surface-2/60 border border-line rounded-lg px-3 py-2.5 text-xs text-ink-muted leading-relaxed">
          内置免费模型 (Agnes) 会在首次启动时自动配置。如需使用 GPT / Gemini / Claude
          等更强模型，请添加自己的 OpenAI 兼容服务商（Base URL + API Key）。
        </div>
      )}

      {/* Provider cards */}
      <div className="space-y-2">
        {providers.map((p) => {
          const t = tests[p.id]
          const st = statusById[p.id]
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
                    {p.id === 'builtin-agnes' && (
                      <span
                        className="text-[10px] text-done bg-done/15 px-1.5 py-0.5 rounded font-medium"
                        title="内置免费模型，开箱即用"
                      >
                        免费
                      </span>
                    )}
                    {p.id === 'hermes-remote' && (
                      <span
                        className="text-[10px] text-sky bg-elevated/60 px-1.5 py-0.5 rounded"
                        title="远端 Hermes Agent 端点（在 设置 → 远端处理 (Hermes) 中管理）"
                      >
                        远端 Agent
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-dim truncate">{p.base_url}</p>
                  <p className="text-xs mt-0.5">
                    {p.has_key ? (
                      <span className="text-done">
                        Key 已设置（{p.key_mask}）
                      </span>
                    ) : p.id === 'hermes-remote' ? (
                      <span className="text-ink-dim">
                        Key 未设置（Hermes 未开鉴权时可留空）
                      </span>
                    ) : (
                      <span className="text-awaiting">Key 未设置</span>
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

              {/* Health status (from providers_models_status) */}
              {!p.enabled ? (
                <p className="text-xs text-ink-dim">已禁用（不参与模型聚合）</p>
              ) : st ? (
                st.ok ? (
                  <p
                    className="text-xs text-done"
                    title={st.models.map((m) => m.id).join(', ')}
                  >
                    ✓ {st.models.length} 个可用模型
                  </p>
                ) : (
                  <div className="bg-red-900/20 border border-red-900/40 rounded px-2 py-1.5 space-y-1.5">
                    <p className="text-xs text-failed break-words">
                      ✗ 无法使用：{st.error ?? '未知错误'}
                    </p>
                    <div className="flex items-center gap-3 text-xs">
                      <button
                        onClick={() => startEdit(p)}
                        className="text-sky hover:text-sky transition-colors"
                      >
                        更新 Key
                      </button>
                      <button
                        onClick={() => setConfirmDelete(p.id)}
                        className="text-failed hover:text-failed transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )
              ) : statusLoading || !statusLoaded ? (
                <p className="text-xs text-ink-dim">健康检查中…</p>
              ) : null}

              <div className="flex items-center gap-3 text-xs">
                <button
                  onClick={() => runTest(p.id)}
                  disabled={t === 'loading'}
                  className="text-sky hover:text-sky disabled:text-ink-dim transition-colors"
                >
                  {t === 'loading' ? '测试中…' : '测试连接'}
                </button>
                <button
                  onClick={() => startEdit(p)}
                  className="text-ink-muted hover:text-ink transition-colors"
                >
                  编辑
                </button>
                {confirmDelete === p.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-failed">确认?</span>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="text-failed hover:text-failed"
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
                    className="text-ink-dim hover:text-failed transition-colors"
                  >
                    删除
                  </button>
                )}
              </div>

              {t && t !== 'loading' && (
                <p
                  className={`text-xs rounded px-2 py-1 break-words ${
                    t.success
                      ? 'bg-green-900/30 text-done'
                      : 'bg-red-900/30 text-failed'
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
          {formError && <p className="text-xs text-failed">{formError}</p>}
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
              placeholder="https://api.xxx.com/v1"
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
                  {opt === 'chat' ? 'chat（默认，兼容性最好）' : opt}
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
              onClick={() => void submit(false)}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-elevated hover:bg-elevated disabled:opacity-40 text-ink rounded transition-colors"
            >
              {busy ? '保存中…' : '仅保存'}
            </button>
            <button
              onClick={() => void submit(true)}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-sakura hover:bg-sakura disabled:opacity-40 text-white rounded transition-colors"
            >
              {busy ? '保存中…' : '保存并测试连接'}
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
        Codex CLI 引擎配置（高级）
      </h3>
      <p className="text-xs text-ink-dim -mt-2">
        仅用于任务派发的 Codex CLI 引擎：写入{' '}
        <code className="text-ink-muted">~/.codex/config.toml</code> 和{' '}
        <code className="text-ink-muted">auth.json</code>；修改对新会话生效，写入前自动备份。
        聊天/生成/工作台请使用上方「模型服务商」。
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
              <span className="text-done ml-1">（已设置）</span>
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
            saveResult.startsWith('保存失败') ? 'text-failed' : 'text-done'
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
              ? 'bg-green-900/30 text-done'
              : 'bg-red-900/30 text-failed'
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
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [iris, setIris] = useState<PiEngineStatusInfo | null>(null)
  const [probing, setProbing] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const all = await tauriInvoke<Record<string, string>>('settings_get_all')
      setSettings(all)
    } catch (e) {
      console.error('Failed to load settings:', e)
    }
  }, [])

  const loadIris = useCallback(async () => {
    setProbing(true)
    try {
      const st = await tauriInvoke<PiEngineStatusInfo>('pi_engine_status')
      setIris(st)
    } catch (e) {
      console.error('pi_engine_status failed:', e)
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
    loadIris()
  }, [loadSettings, loadIris])

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

  const currentPolicy = settings['confirmation_policy'] ?? 'auto'
  const currentEffort = settings['reasoning_effort'] ?? 'low'
  const currentWorkdir = settings['default_workdir'] ?? ''

  return (
    <div className="space-y-5">
      {/* 内置引擎（Iris） */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
            内置引擎（Iris）
          </h3>
          <button
            onClick={loadIris}
            disabled={probing}
            className="text-xs text-sky hover:text-sky disabled:text-ink-dim transition-colors"
          >
            {probing ? '检测中…' : '重新检测'}
          </button>
        </div>

        <div className="bg-surface border border-line rounded-lg p-3 space-y-2.5">
          {/* 总体就绪状态 */}
          <div className="flex items-center gap-2.5">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                iris == null
                  ? 'bg-elevated'
                  : iris.bundled || (iris.node.found && iris.pi.found)
                    ? 'bg-done'
                    : 'bg-failed'
              }`}
            />
            <span className="text-sm font-medium text-ink">
              {iris == null
                ? '检测中…'
                : iris.bundled
                  ? '已内置，开箱即用'
                  : iris.node.found && iris.pi.found
                    ? '就绪（开发模式：使用本机运行时）'
                    : '未就绪'}
            </span>
          </div>
          <p className="text-xs text-ink-dim">
            Iris 内置编码引擎，无需安装任何依赖。安装版应用自带全部运行时；开发模式下检测不到内置资源时，自动改用系统
            PATH 中的运行时。
          </p>

          {/* Node 运行时 */}
          <div className="flex items-start gap-2">
            <span
              className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                iris?.node.found ? 'bg-done' : 'bg-failed'
              }`}
            />
            <div className="min-w-0">
              <p className="text-xs text-ink-muted">
                Node 运行时
                {iris?.node.found && (
                  <span className="text-ink-dim">
                    {' · '}
                    {SOURCE_LABEL[iris.node.source] ?? iris.node.source}
                    {iris.node.version ? ` · ${iris.node.version}` : ''}
                  </span>
                )}
              </p>
              {iris == null ? (
                <p className="text-xs text-ink-dim">检测中…</p>
              ) : iris.node.found ? (
                iris.node.path != null && (
                  <p className="text-xs text-ink-dim font-mono break-all">
                    {iris.node.path}
                  </p>
                )
              ) : (
                <p className="text-xs text-failed">
                  未找到 Node 运行时。开发模式请确保 PATH 中有 node；安装版应用自带，无需处理。
                </p>
              )}
            </div>
          </div>

          {/* pi 引擎 */}
          <div className="flex items-start gap-2">
            <span
              className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                iris?.pi.found ? 'bg-done' : 'bg-failed'
              }`}
            />
            <div className="min-w-0">
              <p className="text-xs text-ink-muted">
                pi 引擎
                {iris?.pi.found && (
                  <span className="text-ink-dim">
                    {' · '}
                    {SOURCE_LABEL[iris.pi.source] ?? iris.pi.source}
                  </span>
                )}
              </p>
              {iris == null ? (
                <p className="text-xs text-ink-dim">检测中…</p>
              ) : iris.pi.found ? (
                iris.pi.path != null && (
                  <p className="text-xs text-ink-dim font-mono break-all">
                    {iris.pi.path}
                  </p>
                )
              ) : (
                <p className="text-xs text-failed">
                  未找到 pi 引擎。开发模式请全局安装 @earendil-works/pi-coding-agent，或在设置中指定
                  pi_dist_path；安装版应用自带，无需处理。
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
                      <span className="text-xs text-failed">确认删除?</span>
                      <button
                        onClick={() => handleRemove(s.name)}
                        className="text-xs text-failed hover:text-failed"
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
                      className="text-xs text-ink-dim hover:text-failed transition-colors"
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
            <p className="text-xs text-failed">{formError}</p>
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

// ── Chat Binding Section (replaces Feishu + WeChat Work) ─────────────────────

function ChatBindingSection() {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState(0)
  const [countdown, setCountdown] = useState('')
  const [generating, setGenerating] = useState(false)
  const [bindings, setBindings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Load bindings on mount
  useEffect(() => {
    loadBindings()
  }, [])

  // Countdown timer for the code
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => {
      const remaining = Math.max(0, expiresAt - Date.now())
      if (remaining <= 0) {
        setCode(null)
        setCountdown('')
        clearInterval(timer)
        return
      }
      const min = Math.floor(remaining / 60000)
      const sec = Math.floor((remaining % 60000) / 1000)
      setCountdown(`${min}:${String(sec).padStart(2, '0')}`)
    }, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  async function loadBindings() {
    try {
      const result = await tauriInvoke<any[]>('sync_list_chat_bindings')
      setBindings(result)
    } catch {
      setBindings([])
    }
    setLoading(false)
  }

  async function generateCode() {
    setGenerating(true)
    try {
      const result = await tauriInvoke<{ code: string; expires_at: number }>('sync_generate_bind_code')
      setCode(result.code)
      setExpiresAt(result.expires_at)
    } catch (e) {
      alert(String(e))
    }
    setGenerating(false)
  }

  async function unbind(id: string) {
    try {
      await tauriInvoke('sync_delete_chat_binding', { id })
      setBindings(prev => prev.filter(b => b.id !== id))
    } catch (e) {
      alert(String(e))
    }
  }

  const platformLabel = (p: string) => p === 'feishu' ? '飞书' : p === 'wecom' ? '企业微信' : p

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold text-ink mb-1">聊天平台绑定</h3>
        <p className="text-sm text-ink-dim">通过飞书或企业微信远程控制桌面端 Iris</p>
      </div>

      {/* Instructions */}
      <div className="bg-surface rounded-lg p-4 text-sm text-ink-dim space-y-2">
        <p className="font-medium text-ink">使用步骤：</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>在飞书或企业微信中添加 Iris 机器人到群聊或私聊</li>
          <li>点击下方按钮生成 6 位绑定码</li>
          <li>在聊天中发送「绑定 XXXXXX」完成绑定</li>
          <li>绑定后，直接在聊天中发消息即可命令桌面端</li>
        </ol>
      </div>

      {/* Generate button */}
      <div>
        <button
          onClick={generateCode}
          disabled={generating}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {generating ? '生成中...' : '生成绑定码'}
        </button>
      </div>

      {/* Bind code display */}
      {code && (
        <div className="bg-primary/10 border border-primary/20 rounded-lg p-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl font-mono font-bold tracking-[0.3em] text-primary">{code}</span>
            <span className="text-sm text-ink-dim">剩余 {countdown}</span>
          </div>
          <p className="text-sm text-ink-dim mt-2">
            在飞书或企业微信中发送「<span className="text-ink font-medium">绑定 {code}</span>」
          </p>
        </div>
      )}

      {/* Bindings list */}
      <div>
        <h4 className="text-sm font-medium text-ink mb-3">已绑定的聊天</h4>
        {loading ? (
          <p className="text-sm text-ink-muted">加载中...</p>
        ) : bindings.length === 0 ? (
          <p className="text-sm text-ink-muted">暂无已绑定的聊天</p>
        ) : (
          <div className="space-y-2">
            {bindings.map(b => (
              <div key={b.id} className="flex items-center justify-between bg-surface rounded-lg px-4 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-primary">●</span>
                  <span className="font-medium text-ink">{platformLabel(b.platform)}</span>
                  {b.chat_type && <span className="text-ink-muted">· {b.chat_type}</span>}
                  <span className="text-ink-faint">· {new Date(b.bound_at).toLocaleDateString()}</span>
                </div>
                <button
                  onClick={() => unbind(b.id)}
                  className="text-xs text-ink-muted hover:text-red-400 transition-colors"
                >
                  解绑
                </button>
              </div>
            ))}
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
            <span className="text-xs text-awaiting bg-yellow-900/30 px-1.5 py-0.5 rounded">
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
              <span className="text-xs text-awaiting bg-yellow-900/30 px-1.5 py-0.5 rounded">
                敬请期待
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ── 账号与同步 Section（A3 长连接 + v0.8 账号门户） ───────────────────────────

// 绑定占位（v0.8）：真实 OAuth / 短信登录需要对应平台资质（短信服务 / 微信
// 开放平台 / QQ 互联），资质到位后再接入；本期仅提供 UI 框架与路线说明。
const BIND_ITEMS = [
  {
    key: 'phone',
    label: '手机号',
    desc: '手机号 + 短信验证码登录',
    note: '手机号绑定需要配置短信服务平台，即将开放。',
  },
  {
    key: 'wechat',
    label: '微信',
    desc: '微信扫码快捷登录',
    note: '微信绑定需要接入微信开放平台（应用资质审核），即将开放。',
  },
  {
    key: 'qq',
    label: 'QQ',
    desc: 'QQ 快捷登录',
    note: 'QQ 绑定需要接入 QQ 互联平台（应用资质审核），即将开放。',
  },
] as const

function BindSection() {
  const [openKey, setOpenKey] = useState<string | null>(null)

  return (
    <div>
      <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
        账号绑定
      </p>
      <div className="space-y-1.5">
        {BIND_ITEMS.map((b) => (
          <div key={b.key} className="bg-surface border border-line rounded-lg px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-ink">{b.label}</p>
                <p className="text-xs text-ink-dim mt-0.5">{b.desc}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-ink-dim bg-surface-2 px-1.5 py-0.5 rounded">
                  未绑定
                </span>
                <button
                  onClick={() => setOpenKey((k) => (k === b.key ? null : b.key))}
                  className="text-xs text-primary hover:text-primary-hover transition-colors"
                >
                  绑定
                </button>
              </div>
            </div>
            {openKey === b.key && (
              <p className="mt-2 text-xs text-ink-muted bg-primary-tint border border-lavender/40 rounded px-2 py-1.5 leading-relaxed">
                {b.note}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SyncSection() {
  const status = useAuthStore((s) => s.status)
  const refresh = useAuthStore((s) => s.refresh)
  const authLogout = useAuthStore((s) => s.logout)
  const openPortal = useAuthStore((s) => s.openPortal)
  const [submitting, setSubmitting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pairingUri, setPairingUri] = useState('')

  useEffect(() => {
    void initializeRemoteRootKey()
      .then(() => setPairingUri(encodePairingPayload(createPairingPayload('https://192-210-231-152.nip.io:8443'))))
      .catch((error) => setActionError(`初始化端到端加密失败：${String(error)}`))
  }, [])

  // 账号状态由 authStore 统一维护（与门户/侧栏一致）；这里加快轮询以便
  // 设备列表与连接状态及时刷新。
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const doLogout = async () => {
    setSubmitting(true)
    setActionError(null)
    try {
      await authLogout()
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
      await refresh()
    } catch (e) {
      console.error('sync_set_enabled failed:', e)
    } finally {
      setToggling(false)
    }
  }

  const state = status?.state ?? 'disabled'
  const dotClass =
    state === 'connected'
      ? 'bg-done'
      : state === 'connecting' || state === 'reconnecting'
        ? 'bg-awaiting'
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
          登录同一账号的设备间同步任务、进度与对话内容；数据按账号隔离，各账号互不可见。
          对话正文会同步（API 密钥绝不上传，附件仅同步文本与文件名、大图不上传）。
        </p>
      </div>

      {status?.logged_in ? (
        // ── Logged in ────────────────────────────────────────────────────────
        <div className="space-y-4">
          {/* Account + connection */}
          <div className="bg-surface border border-line rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-xs text-ink-dim">当前账号</p>
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
              <p className="text-xs text-failed break-words">{status.last_error}</p>
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

          {/* Happy-style E2EE device pairing. The root key exists only inside
              this QR and paired clients; it is never uploaded to the server. */}
          <div className="bg-surface border border-line rounded-lg p-4">
            <p className="text-sm font-medium text-ink">端到端加密配对</p>
            <p className="text-xs text-ink-dim mt-1 leading-relaxed">
              在 Android Iris 的设置中扫描二维码。编码会话、工具输出和 diff
              会在本机加密，中转服务器只能保存密文。
            </p>
            <div className="mt-3 inline-flex rounded-xl bg-white p-3">
              {pairingUri ? (
                <QRCodeSVG value={pairingUri} size={184} level="M" />
              ) : (
                <div className="w-[184px] h-[184px] grid place-items-center text-xs text-gray-500">正在加载安全密钥…</div>
              )}
            </div>
            <p className="mt-2 text-[11px] text-ink-dim">
              二维码包含解密密钥，请勿截图或发送给他人。
            </p>
          </div>

          {/* 绑定占位（手机号 / 微信 / QQ） */}
          <BindSection />

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
          <p className="text-xs text-ink-dim -mt-2">
            退出后回到本地模式：本地数据保留，仅停止跨端同步。
          </p>
          {actionError && <p className="text-xs text-failed">{actionError}</p>}
        </div>
      ) : (
        // ── Logged out（本地模式）：登录/注册统一走账号门户，不再放重复表单 ──
        <div className="space-y-4">
          <div className="bg-surface border border-line rounded-lg p-3">
            <p className="text-sm font-medium text-ink">本地模式（未登录）</p>
            <p className="text-xs text-ink-dim mt-1 leading-relaxed">
              当前所有数据仅保存在本机。登录账号后，本机已有的任务与对话会自动上传到该账号，
              手机端登录同一账号即可同步查看与远程派发。
            </p>
          </div>
          <button
            onClick={openPortal}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm rounded-lg transition-colors"
          >
            登录 / 注册账号
          </button>
        </div>
      )}
    </div>
  )
}

// ── Settings page ─────────────────────────────────────────────────────────────

// ── Remote Hermes Section（远端处理端点配置） ─────────────────────────────────

/** Mirrors Rust hermes::HermesConfig. */
interface HermesConfigInfo {
  configured: boolean
  base_url: string
  model: string
  enabled: boolean
  has_key: boolean
  key_mask: string
}

const HERMES_REPO_URL = 'https://github.com/NousResearch/hermes-agent'

function HermesSection() {
  const [cfg, setCfg] = useState<HermesConfigInfo | null>(null)
  const [form, setForm] = useState({ base_url: '', model: '', key: '' })
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [test, setTest] = useState<TestResult | 'loading' | null>(null)

  const load = useCallback(async () => {
    try {
      const c = await tauriInvoke<HermesConfigInfo>('hermes_config_get')
      setCfg(c)
      setForm({ base_url: c.base_url, model: c.model, key: '' })
      setEnabled(c.configured ? c.enabled : true)
    } catch (e) {
      console.error('hermes_config_get failed:', e)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runTest = async () => {
    setTest('loading')
    try {
      const res = await tauriInvoke<TestResult>('hermes_test')
      setTest(res)
    } catch (e) {
      setTest({ success: false, message: String(e), elapsed_ms: 0 })
    }
  }

  /** 保存配置；key 留空 = 不修改已存 Key。testAfter 时保存后立即测试连接。 */
  const save = async (testAfter: boolean) => {
    if (!form.base_url.trim()) {
      setError('请填写 Hermes 端点 URL（如 http://your-host:8642/v1）')
      return
    }
    setBusy(true)
    setError('')
    try {
      await tauriInvoke('hermes_config_set', {
        baseUrl: form.base_url.trim(),
        model: form.model.trim(),
        key: form.key.trim() ? form.key.trim() : null,
        enabled,
      })
      setForm((f) => ({ ...f, key: '' }))
      await load()
      if (testAfter) await runTest()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 清除已存的 API Key（Hermes 未开鉴权时无需 Key）。 */
  const clearKey = async () => {
    if (!cfg?.configured) return
    setBusy(true)
    setError('')
    try {
      await tauriInvoke('hermes_config_set', {
        baseUrl: cfg.base_url,
        model: cfg.model,
        key: '',
        enabled: cfg.enabled,
      })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors'

  return (
    <div className="space-y-4">
      {/* 说明 / 部署指引 */}
      <div className="glass rounded-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
            远端处理 (Hermes)
          </h3>
          <span className="text-[10px] text-sky bg-sakura/40 px-1.5 py-0.5 rounded">
            远端 Agent
          </span>
        </div>
        <p className="text-xs text-ink-dim leading-relaxed">
          Hermes Agent 是 Nous Research 开源（MIT）的远端 agent：部署在你自己的服务器上
          （内存 ≥ 1–2GB），自带记忆与 skills，暴露 OpenAI 兼容 API（默认端口 8642）。
          配置好端点后，可在侧栏「Agent → 远端」把任务与文件委派到远端处理，
          它也会作为一个特殊服务商进入模型下拉。
        </p>
        <p className="text-xs text-ink-dim leading-relaxed">
          部署：
          <button
            onClick={() =>
              void tauriInvoke('open_external_url', { url: HERMES_REPO_URL })
            }
            className="text-sky underline underline-offset-2 mx-1"
          >
            github.com/NousResearch/hermes-agent
          </button>
          按 README 一键安装或 Docker 启动，开启 API 服务器后把地址填到下面即可。
          <span className="text-ink-muted">
            API Key 仅保存在本机凭据管理器，不会上传；Hermes 未开鉴权时可留空。
          </span>
        </p>
      </div>

      {/* 端点表单 */}
      <div className="glass rounded-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
            端点配置
          </h3>
          {cfg?.configured && (
            <button
              onClick={() => setEnabled((v) => !v)}
              className={
                'relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ' +
                (enabled ? 'bg-sakura' : 'bg-elevated')
              }
              title={enabled ? '已启用（点击禁用，保存后生效）' : '已禁用（点击启用，保存后生效）'}
              aria-label="Toggle hermes enabled"
            >
              <span
                className={
                  'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ' +
                  (enabled ? 'translate-x-4' : 'translate-x-0.5')
                }
              />
            </button>
          )}
        </div>

        {error && <p className="text-xs text-failed">{error}</p>}

        <div>
          <label className="block text-xs text-ink-dim mb-1">端点 URL</label>
          <input
            type="text"
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            placeholder="http://your-host:8642/v1 或 https://your-host:8642/v1"
            className={inputCls}
          />
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">
            API Key（可选）
            {cfg?.has_key && (
              <span className="text-done ml-1">已设置（{cfg.key_mask}），留空=不修改</span>
            )}
          </label>
          <input
            type="password"
            value={form.key}
            onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
            placeholder={cfg?.has_key ? '留空保持不变' : 'Hermes API_SERVER 未开鉴权时可留空'}
            autoComplete="new-password"
            className={inputCls}
          />
          {cfg?.has_key && (
            <button
              onClick={() => void clearKey()}
              disabled={busy}
              className="text-xs text-ink-dim hover:text-failed disabled:opacity-40 mt-1 transition-colors"
            >
              清除已存 Key
            </button>
          )}
        </div>

        <div>
          <label className="block text-xs text-ink-dim mb-1">模型名（可选）</label>
          <input
            type="text"
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="留空 = 自动使用端点返回的第一个模型"
            className={inputCls}
          />
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={() => void save(false)}
            disabled={busy}
            className="px-3 py-1.5 text-xs bg-elevated hover:bg-elevated disabled:opacity-40 text-ink rounded transition-colors"
          >
            {busy ? '保存中…' : '仅保存'}
          </button>
          <button
            onClick={() => void save(true)}
            disabled={busy}
            className="px-3 py-1.5 text-xs bg-sakura hover:bg-sakura disabled:opacity-40 text-white rounded transition-colors"
          >
            {busy ? '保存中…' : '保存并测试连接'}
          </button>
          {cfg?.configured && (
            <button
              onClick={() => void runTest()}
              disabled={test === 'loading'}
              className="px-3 py-1.5 text-xs text-sky hover:text-sky disabled:text-ink-dim border border-line rounded transition-colors"
            >
              {test === 'loading' ? '测试中…' : '测试连接'}
            </button>
          )}
        </div>

        {test && test !== 'loading' && (
          <p
            className={
              'text-xs rounded px-2 py-1 break-words ' +
              (test.success ? 'bg-green-900/30 text-done' : 'bg-red-900/30 text-failed')
            }
          >
            {test.message}
          </p>
        )}

        {cfg && !cfg.configured && (
          <p className="text-xs text-ink-dim">
            尚未配置端点。部署好 Hermes 后填上地址，即可在「Agent → 远端」委派任务。
          </p>
        )}
      </div>
    </div>
  )
}

type SectionId =
  | 'engine'
  | 'hermes'
  | 'mcp'
  | 'sync'
  | 'chat'
  | 'skills'
  | 'market'

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
    id: 'hermes',
    title: '远端处理 (Hermes)',
    description:
      '配置远端 Hermes Agent 端点（OpenAI 兼容，默认端口 8642），把任务与文件委派到你自己的服务器上处理。',
  },
  {
    id: 'mcp',
    title: 'MCP 工具',
    description: '管理 Model Context Protocol 工具连接，扩展 Agent 能力。',
  },
  {
    id: 'sync',
    title: '账号与同步',
    description: '登录/注册、账号绑定与跨端同步：同一账号下手机与电脑实时同步任务、进度与对话。',
  },
  {
    id: 'chat',
    title: '聊天绑定',
    description: '飞书 / 企业微信远程控制桌面端 Iris，通过绑定码一键关联。',
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
            {activeSection === 'hermes' && <HermesSection />}
            {activeSection === 'mcp' && <McpSection />}
            {activeSection === 'sync' && <SyncSection />}
            {activeSection === 'chat' && <ChatBindingSection />}
            {activeSection === 'skills' && <SkillsSection />}
            {activeSection === 'market' && <AgentMarketSection />}
          </div>
        )}
      </div>
    </div>
  )
}
