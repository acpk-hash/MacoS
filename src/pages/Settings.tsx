import { useEffect, useState, useCallback } from 'react'

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
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        模型服务
      </h3>
      <p className="text-xs text-gray-500 -mt-2">
        写入 <code className="text-gray-400">~/.codex/config.toml</code> 和{' '}
        <code className="text-gray-400">auth.json</code>；修改对新会话生效，写入前自动备份。
      </p>

      <div className="space-y-3">
        {/* Provider name */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">服务商名称 (model_provider)</label>
          <input
            type="text"
            value={form.provider_name}
            onChange={(e) => setForm((f) => ({ ...f, provider_name: e.target.value }))}
            placeholder="OpenAI"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        {/* base_url */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Base URL</label>
          <input
            type="text"
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            placeholder="https://api.openai.com"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        {/* wire_api */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Wire API</label>
          <select
            value={form.wire_api}
            onChange={(e) => setForm((f) => ({ ...f, wire_api: e.target.value }))}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm
                       text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
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
          <label className="block text-xs text-gray-500 mb-1">模型名称 (model)</label>
          <input
            type="text"
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder="gpt-5.5"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        {/* reasoning effort — reuses REASONING_EFFORT_OPTIONS, linked to the
            existing "推理深度" dropdown via settings_set on save */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            推理力度 (model_reasoning_effort)
          </label>
          <select
            value={form.model_reasoning_effort}
            onChange={(e) =>
              setForm((f) => ({ ...f, model_reasoning_effort: e.target.value }))
            }
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm
                       text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
          >
            {REASONING_EFFORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-600 mt-0.5">
            保存时同步写入 config.toml 和应用设置
          </p>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">
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
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
          <p className="text-xs text-gray-600 mt-0.5">
            留空=不修改；写入 auth.json（无 BOM UTF-8，不入数据库）
          </p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700
                     text-white text-sm rounded-lg transition-colors"
        >
          {saving ? '保存中…' : '保存配置'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800
                     text-gray-200 text-sm rounded-lg transition-colors"
        >
          {testing ? '测试中…' : '测试连通'}
        </button>
      </div>

      {/* Save result */}
      {saveResult && (
        <p
          className={`text-xs ${
            saveResult.startsWith('保存失败') ? 'text-red-400' : 'text-green-400'
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
              ? 'bg-green-900/30 text-green-300'
              : 'bg-red-900/30 text-red-300'
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

  useEffect(() => {
    loadSettings()
    detect()
  }, [detect, loadSettings])

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
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            引擎状态
          </h3>
          <button
            onClick={detect}
            disabled={detecting}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
          >
            {detecting ? '检测中…' : '重新检测'}
          </button>
        </div>

        <div className="space-y-2">
          {/* Codex */}
          <div className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  codexEngine?.available ? 'bg-green-400' : 'bg-gray-600'
                }`}
              />
              <span className="text-sm font-medium text-gray-200">Codex</span>
            </div>
            <span className="text-xs text-gray-400">
              {detecting
                ? '…'
                : codexEngine?.available
                  ? codexEngine.version ?? '已安装'
                  : '未安装'}
            </span>
          </div>

          {/* Claude (coming soon) */}
          <div className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2.5 opacity-50">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  claudeEngine?.available ? 'bg-green-400' : 'bg-gray-600'
                }`}
              />
              <span className="text-sm font-medium text-gray-200">Claude</span>
            </div>
            <span className="text-xs text-yellow-600 bg-yellow-900/30 px-1.5 py-0.5 rounded">
              即将支持
            </span>
          </div>
        </div>
      </div>

      {/* Default engine */}
      <div>
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          默认引擎
        </label>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="default_engine"
              value="codex"
              checked={true}
              readOnly
              className="accent-blue-500"
            />
            <span className="text-sm text-gray-200">Codex</span>
          </label>
          <label className="flex items-center gap-2 cursor-not-allowed opacity-40">
            <input type="radio" name="default_engine" value="claude" disabled />
            <span className="text-sm text-gray-400">Claude</span>
            <span className="text-xs text-yellow-600">即将支持</span>
          </label>
        </div>
      </div>

      {/* Default workdir */}
      <div>
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
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
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200
                       placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={pickWorkdir}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg
                       transition-colors whitespace-nowrap"
          >
            选择目录
          </button>
        </div>
        {currentWorkdir && (
          <p className="text-xs text-gray-500 mt-1">
            新会话/新任务的工作目录默认值
          </p>
        )}
      </div>

      {/* Confirmation policy */}
      <div>
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
          确认策略
        </label>
        <p className="text-xs text-gray-500 mb-2">
          即将生效 — 存储当前策略并在 Chat 页展示徽标，拦截逻辑将在后续版本接入。
        </p>
        <select
          value={currentPolicy}
          onChange={(e) => saveSetting('confirmation_policy', e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                     text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
        >
          <option value="auto">自动执行</option>
          <option value="per_file">逐文件批准</option>
        </select>
        {saving['confirmation_policy'] && (
          <p className="text-xs text-gray-500 mt-1">保存中…</p>
        )}
      </div>

      {/* Reasoning effort */}
      <div>
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          推理深度 (reasoning effort)
        </label>
        <select
          value={currentEffort}
          onChange={(e) => saveSetting('reasoning_effort', e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                     text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
        >
          {REASONING_EFFORT_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          已生效：新 Agent 会话和跟进回复将以 <code className="text-gray-400">-c model_reasoning_effort={currentEffort}</code> 启动 Codex
        </p>
        {saving['reasoning_effort'] && (
          <p className="text-xs text-blue-400 mt-1">已保存</p>
        )}
      </div>

      {/* Model service config (config.toml + auth.json) */}
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
      <p className="text-xs text-gray-500 leading-relaxed">
        管理 Codex CLI 的 MCP 服务器配置（
        <code className="text-gray-400">~/.codex/config.toml</code>）。
        修改对新会话生效，写入前自动备份 config.toml.bak。
      </p>

      {/* Server list */}
      {loading ? (
        <p className="text-xs text-gray-500">加载中…</p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-gray-500 italic">暂无 MCP 服务器</p>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div
              key={s.name}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-200">{s.name}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {s.command}
                    {s.args.length > 0 && (
                      <span className="text-gray-600"> {s.args.join(' ')}</span>
                    )}
                  </p>
                  {Object.keys(s.env).length > 0 && (
                    <p className="text-xs text-gray-600">
                      env: {Object.keys(s.env).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {confirmDelete === s.name ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-400">确认删除?</span>
                      <button
                        onClick={() => handleRemove(s.name)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="text-xs text-gray-500 hover:text-gray-400"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(s.name)}
                      className="text-xs text-gray-600 hover:text-red-400 transition-colors"
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
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-3">
          <h4 className="text-xs font-semibold text-gray-300">添加 MCP 服务器</h4>
          {formError && (
            <p className="text-xs text-red-400">{formError}</p>
          )}
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="my-mcp-server"
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs
                           text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">命令</label>
              <input
                type="text"
                value={form.command}
                onChange={(e) =>
                  setForm((f) => ({ ...f, command: e.target.value }))
                }
                placeholder="npx"
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs
                           text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                参数（空格分隔）
              </label>
              <input
                type="text"
                value={form.argsText}
                onChange={(e) =>
                  setForm((f) => ({ ...f, argsText: e.target.value }))
                }
                placeholder="-y @modelcontextprotocol/server-fetch"
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs
                           text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                环境变量（每行 KEY=VALUE）
              </label>
              <textarea
                value={form.envText}
                onChange={(e) =>
                  setForm((f) => ({ ...f, envText: e.target.value }))
                }
                rows={3}
                placeholder="API_KEY=xxx"
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs
                           text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
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
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-300 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={submitting}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700
                         text-white rounded transition-colors"
            >
              {submitting ? '添加中…' : '添加'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full py-2 border border-dashed border-gray-700 hover:border-gray-500
                     rounded-lg text-xs text-gray-500 hover:text-gray-400 transition-colors"
        >
          + 添加 MCP 服务器
        </button>
      )}
    </div>
  )
}

// ── Feishu Section ────────────────────────────────────────────────────────────

function FeishuSection() {
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

  const enabled = settings['feishu_enabled'] === 'true'

  return (
    <div className="space-y-5">
      {/* 开关 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-200">启用飞书推送</p>
          <p className="text-xs text-gray-500 mt-0.5">
            任务完成或失败时向指定用户发送交互卡片
          </p>
        </div>
        <button
          onClick={() => saveSetting('feishu_enabled', enabled ? 'false' : 'true')}
          className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${
            enabled ? 'bg-blue-500' : 'bg-gray-600'
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
          <label className="block text-xs text-gray-500 mb-1">App ID</label>
          <input
            type="text"
            value={settings['feishu_app_id'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, feishu_app_id: e.target.value }))
            }
            onBlur={(e) => saveSetting('feishu_app_id', e.target.value)}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">App Secret</label>
          <input
            type="password"
            value={settings['feishu_app_secret'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, feishu_app_secret: e.target.value }))
            }
            onBlur={(e) => saveSetting('feishu_app_secret', e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">接收者 ID 类型</label>
          <select
            value={settings['feishu_receive_id_type'] ?? 'open_id'}
            onChange={(e) => saveSetting('feishu_receive_id_type', e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
          >
            <option value="open_id">open_id（个人）</option>
            <option value="chat_id">chat_id（群组）</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">接收者 ID</label>
          <input
            type="text"
            value={settings['feishu_receive_id'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, feishu_receive_id: e.target.value }))
            }
            onBlur={(e) => saveSetting('feishu_receive_id', e.target.value)}
            placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>
      </div>

      {/* Test button */}
      <div>
        <button
          onClick={sendTest}
          disabled={testing}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white
                     text-sm rounded-lg transition-colors"
        >
          {testing ? '发送中…' : '发送测试卡片'}
        </button>
        {testResult && (
          <p
            className={`text-xs mt-2 ${
              testResult.startsWith('成功') ? 'text-green-400' : 'text-red-400'
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
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          {showLogs ? '收起推送日志 ▲' : '最近推送日志 ▼'}
        </button>
        {showLogs && (
          <div className="mt-2 bg-gray-900 rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
            {logs.length === 0 ? (
              <p className="text-xs text-gray-600 italic">暂无日志</p>
            ) : (
              logs.map((entry, i) => (
                <p
                  key={i}
                  className={`text-xs font-mono ${
                    entry.includes('ERR') ? 'text-red-400' : 'text-green-400'
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
          className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
        >
          {showGuide ? '收起配置指引 ▲' : '如何配置 ▼'}
        </button>
        {showGuide && (
          <div className="mt-2 bg-gray-900 rounded-lg p-3 text-xs text-gray-400 space-y-2 leading-relaxed">
            <p>
              1. 打开{' '}
              <code className="text-gray-300">open.feishu.cn</code> →
              开发者后台 → 创建企业自建应用
            </p>
            <p>2. 应用能力里开启「机器人」</p>
            <p>
              3. 权限管理开通{' '}
              <code className="text-gray-300">im:message</code>
              （获取与发送单聊、群组消息）并发布版本
            </p>
            <p>
              4. 凭证与基础信息页复制 App ID 和 App Secret 填到这里
            </p>
            <p>
              5. receive_id 填你自己的 open_id（可在飞书管理后台或通过给机器人发消息后从事件日志获取），类型选 open_id
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
      <p className="text-xs text-gray-500 leading-relaxed">
        浏览并启用预置技能，快速赋能 Agent 工作流。Skills 功能即将上线。
      </p>
      {placeholders.map((p) => (
        <div
          key={p.name}
          className="bg-gray-900 border border-gray-700/50 rounded-lg px-3 py-3 opacity-50"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-300">{p.name}</p>
              <p className="text-xs text-gray-500 mt-0.5">{p.desc}</p>
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
      <p className="text-xs text-gray-500 leading-relaxed">
        从社区市场安装预构建 Agent，一键部署到本地看板，开箱即用。Agent 市场即将上线。
      </p>
      <div className="grid grid-cols-1 gap-2">
        {cards.map((c) => (
          <div
            key={c.name}
            className="bg-gray-900 border border-gray-700/50 rounded-lg px-3 py-3 opacity-50"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-300">{c.name}</p>
                <p className="text-xs text-gray-600 mt-0.5">{c.org}</p>
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
          <p className="text-sm font-medium text-gray-200">启用企业微信推送</p>
          <p className="text-xs text-gray-500 mt-0.5">
            任务完成或失败时向个人微信发送通知（需先扫码关注）
          </p>
        </div>
        <button
          onClick={() => saveSetting('wecom_enabled', enabled ? 'false' : 'true')}
          className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${
            enabled ? 'bg-blue-500' : 'bg-gray-600'
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
          <label className="block text-xs text-gray-500 mb-1">企业ID (corpid)</label>
          <input
            type="text"
            value={settings['wecom_corpid'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_corpid: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_corpid', e.target.value)}
            placeholder="ww_xxxxxxxxxxxxxxxx"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">应用 Secret (corpsecret)</label>
          <input
            type="password"
            value={settings['wecom_corpsecret'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_corpsecret: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_corpsecret', e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">AgentId</label>
          <input
            type="text"
            value={settings['wecom_agentid'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_agentid: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_agentid', e.target.value)}
            placeholder="1000002"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">
            接收者 (touser)
            <span className="ml-1 text-gray-600">— 默认 @all</span>
          </label>
          <input
            type="text"
            value={settings['wecom_touser'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_touser: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_touser', e.target.value)}
            placeholder="@all 或成员账号"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">
            微信插件二维码链接 (wecom_qr_url)
            <span className="ml-1 text-gray-600">— 可选</span>
          </label>
          <input
            type="text"
            value={settings['wecom_qr_url'] ?? ''}
            onChange={(e) =>
              setSettings((s) => ({ ...s, wecom_qr_url: e.target.value }))
            }
            onBlur={(e) => saveSetting('wecom_qr_url', e.target.value)}
            placeholder="https://..."
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500
                       transition-colors"
          />
        </div>
      </div>

      {/* QR code display */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <p className="text-xs text-gray-500 mb-3">
          微信插件二维码 — 成员扫码后应用消息直达个人微信
        </p>
        {qrUrl ? (
          <img
            src={qrUrl}
            alt="企业微信微信插件二维码"
            className="w-40 h-40 object-contain rounded-lg border border-gray-600"
          />
        ) : (
          <p className="text-xs text-gray-600 italic leading-relaxed">
            在企业微信管理后台 → 我的企业 → 微信插件 页面获取邀请二维码链接，填入上方字段后此处将显示二维码。
          </p>
        )}
      </div>

      {/* Test button */}
      <div>
        <button
          onClick={sendTest}
          disabled={testing}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white
                     text-sm rounded-lg transition-colors"
        >
          {testing ? '发送中…' : '发送测试消息'}
        </button>
        {testResult && (
          <p
            className={`text-xs mt-2 ${
              testResult.startsWith('成功') ? 'text-green-400' : 'text-red-400'
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
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          {showLogs ? '收起推送日志 ▲' : '最近推送日志 ▼'}
        </button>
        {showLogs && (
          <div className="mt-2 bg-gray-900 rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
            {logs.length === 0 ? (
              <p className="text-xs text-gray-600 italic">暂无日志</p>
            ) : (
              logs.map((entry, i) => (
                <p
                  key={i}
                  className={`text-xs font-mono ${
                    entry.includes('ERR') ? 'text-red-400' : 'text-green-400'
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
          className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
        >
          {showGuide ? '收起配置指引 ▲' : '如何配置 ▼'}
        </button>
        {showGuide && (
          <div className="mt-2 bg-gray-900 rounded-lg p-3 text-xs text-gray-400 space-y-2 leading-relaxed">
            <p>
              1. 前往{' '}
              <code className="text-gray-300">qy.weixin.qq.com</code>{' '}
              注册企业微信（个人也可注册，免认证）
            </p>
            <p>
              2. 管理后台 → 应用管理 → 创建自建应用，记下{' '}
              <code className="text-gray-300">AgentId</code> 和{' '}
              <code className="text-gray-300">Secret</code>
            </p>
            <p>
              3. 管理后台 → 我的企业，记下{' '}
              <code className="text-gray-300">企业ID (corpid)</code>，填入上方
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

// ── Settings page ─────────────────────────────────────────────────────────────

type SectionId = 'engine' | 'mcp' | 'feishu' | 'wecom' | 'skills' | 'market'

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
      <div className="px-5 py-3 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2">
          {activeSection && (
            <button
              onClick={() => setActiveSection(null)}
              className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
            >
              ← 返回
            </button>
          )}
          <div>
            <h1 className="text-base font-semibold text-gray-100">
              {activeSection
                ? SECTIONS.find((s) => s.id === activeSection)?.title ?? '设置'
                : '设置'}
            </h1>
            {!activeSection && (
              <p className="text-xs text-gray-500 mt-0.5">配置引擎、工具与技能</p>
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
                className="w-full text-left bg-gray-800 border border-gray-700 rounded-xl p-4
                           hover:border-gray-600 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold text-gray-100">
                      {section.title}
                    </h2>
                    <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                      {section.description}
                    </p>
                  </div>
                  <span className="flex-shrink-0 text-gray-500 text-xs mt-0.5">→</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          // Active section content
          <div>
            {activeSection === 'engine' && <EngineSection />}
            {activeSection === 'mcp' && <McpSection />}
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
