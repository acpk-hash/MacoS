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

// ── Constants ─────────────────────────────────────────────────────────────────

const REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh']

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

// ── Settings page ─────────────────────────────────────────────────────────────

type SectionId = 'engine' | 'mcp' | 'skills' | 'market'

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
            {activeSection === 'skills' && <SkillsSection />}
            {activeSection === 'market' && <AgentMarketSection />}
          </div>
        )}
      </div>
    </div>
  )
}
