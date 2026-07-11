// 扩展中心（G2c）— 工作台内的弹层：MCP 工具 + 本地技能（skills）。
// 复用现有后端能力：mcp_list/mcp_add/mcp_remove（~/.codex/config.toml）与
// sediment_skills（扫描 pi/codex 技能目录）。完整 VSCode .vsix 插件宿主超出
// 桌面应用范围，本期不做，仅在顶部注明。
import { useCallback, useEffect, useState } from 'react'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

interface McpServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

interface SkillInfo {
  name: string
  description: string
  source: string
  path: string
}

type Tab = 'mcp' | 'skills'

export default function ExtensionsPanel({
  open,
  onClose,
  onUseSkill,
}: {
  open: boolean
  onClose: () => void
  onUseSkill: (text: string) => void
}) {
  const [tab, setTab] = useState<Tab>('mcp')
  const [servers, setServers] = useState<McpServer[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', argsText: '', envText: '' })
  const [submitting, setSubmitting] = useState(false)

  const loadMcp = useCallback(async () => {
    if (!isTauri) return
    setLoading(true)
    try {
      setServers(await tauriInvoke<McpServer[]>('mcp_list'))
      setErr(null)
    } catch (e) {
      setErr(`读取 MCP 失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadSkills = useCallback(async () => {
    if (!isTauri) return
    setLoading(true)
    try {
      setSkills(await tauriInvoke<SkillInfo[]>('sediment_skills'))
      setErr(null)
    } catch (e) {
      setErr(`扫描技能失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (tab === 'mcp') void loadMcp()
    else void loadSkills()
  }, [open, tab, loadMcp, loadSkills])

  const parseEnv = (text: string): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const t = line.trim()
      const i = t.indexOf('=')
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
    }
    return env
  }

  const addServer = async () => {
    if (!form.name.trim() || !form.command.trim()) {
      setErr('名称和命令不能为空')
      return
    }
    setSubmitting(true)
    try {
      await tauriInvoke('mcp_add', {
        name: form.name.trim(),
        command: form.command.trim(),
        args: form.argsText.split(/\s+/).map((s) => s.trim()).filter(Boolean),
        env: parseEnv(form.envText),
      })
      setForm({ name: '', command: '', argsText: '', envText: '' })
      setShowAdd(false)
      await loadMcp()
    } catch (e) {
      setErr(`添加失败：${String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  const removeServer = async (name: string) => {
    try {
      await tauriInvoke('mcp_remove', { name })
      await loadMcp()
    } catch (e) {
      setErr(`删除失败：${String(e)}`)
    }
  }

  if (!open) return null

  const TabBtn = ({ id, label, n }: { id: Tab; label: string; n?: number }) => (
    <button
      onClick={() => setTab(id)}
      className={[
        'px-3 py-1.5 rounded-btn text-[12px] transition-colors',
        tab === id ? 'bg-elevated text-ink' : 'text-ink-muted hover:text-ink',
      ].join(' ')}
    >
      {label}
      {n != null && n > 0 && <span className="ml-1.5 text-[10px] text-ink-dim">{n}</span>}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="glass-strong rounded-pop w-full max-w-2xl max-h-[80vh] flex flex-col shadow-glass"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line flex-shrink-0">
          <span className="text-[14px] font-semibold text-gradient">扩展中心</span>
          <div className="flex items-center gap-1.5">
            <TabBtn id="mcp" label="MCP 工具" n={servers.length} />
            <TabBtn id="skills" label="技能" n={skills.length} />
          </div>
          <button
            onClick={onClose}
            className="ml-auto text-ink-dim hover:text-coral text-[16px] leading-none px-1"
            title="关闭"
          >
            ✕
          </button>
        </div>

        <p className="px-4 pt-2 text-[11px] text-ink-dim leading-4 flex-shrink-0">
          扩展 = MCP 工具 + 技能；完整 VSCode 插件宿主在后续版本评估。
        </p>

        {err && <p className="px-4 pt-1 text-[11px] text-coral flex-shrink-0">{err}</p>}

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {loading && <p className="text-[12px] text-ink-dim text-center mt-4">加载中…</p>}

          {!loading && tab === 'mcp' && (
            <div className="space-y-3">
              <p className="text-[11px] text-ink-dim leading-4">
                管理 Codex/pi 的 MCP 服务器（写入 ~/.codex/config.toml，自动备份 .bak）；
                pi / agent 用到时即生效。
              </p>
              {servers.length === 0 ? (
                <p className="text-[12px] text-ink-dim italic">暂无 MCP 服务器</p>
              ) : (
                <div className="space-y-2">
                  {servers.map((s) => (
                    <div key={s.name} className="glass rounded-card border border-line px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-ink">{s.name}</p>
                          <p className="text-[11px] text-ink-dim truncate font-mono">
                            {s.command} {s.args.join(' ')}
                          </p>
                          {Object.keys(s.env).length > 0 && (
                            <p className="text-[11px] text-ink-dim">env: {Object.keys(s.env).join(', ')}</p>
                          )}
                        </div>
                        <button
                          onClick={() => void removeServer(s.name)}
                          className="text-[11px] text-ink-dim hover:text-coral flex-shrink-0"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showAdd ? (
                <div className="glass rounded-card border border-line p-3 space-y-2">
                  <input
                    className="w-full bg-surface-2 border border-line rounded-input px-2 py-1 text-[12px] text-ink placeholder:text-ink-dim focus:outline-none"
                    placeholder="名称 my-mcp"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                  <input
                    className="w-full bg-surface-2 border border-line rounded-input px-2 py-1 text-[12px] text-ink placeholder:text-ink-dim focus:outline-none"
                    placeholder="命令 npx"
                    value={form.command}
                    onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  />
                  <input
                    className="w-full bg-surface-2 border border-line rounded-input px-2 py-1 text-[12px] text-ink placeholder:text-ink-dim focus:outline-none"
                    placeholder="参数（空格分隔）"
                    value={form.argsText}
                    onChange={(e) => setForm((f) => ({ ...f, argsText: e.target.value }))}
                  />
                  <textarea
                    className="w-full bg-surface-2 border border-line rounded-input px-2 py-1 text-[12px] text-ink placeholder:text-ink-dim focus:outline-none resize-none"
                    rows={2}
                    placeholder="环境变量（每行 KEY=VALUE）"
                    value={form.envText}
                    onChange={(e) => setForm((f) => ({ ...f, envText: e.target.value }))}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setShowAdd(false)}
                      className="px-3 py-1 text-[12px] text-ink-muted hover:text-ink"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => void addServer()}
                      disabled={submitting}
                      className="px-3 py-1 rounded-btn bg-grad-primary text-white text-[12px] disabled:opacity-40"
                    >
                      {submitting ? '添加中…' : '添加'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowAdd(true)}
                  className="w-full py-2 border border-dashed border-line hover:border-line-strong rounded-card text-[12px] text-ink-dim hover:text-ink transition-colors"
                >
                  ＋ 添加 MCP 服务器
                </button>
              )}
            </div>
          )}

          {!loading && tab === 'skills' && (
            <div className="space-y-3">
              <p className="text-[11px] text-ink-dim leading-4">
                本地技能（扫描 pi ~/.pi/agent/skills 与 codex ~/.codex/skills）；点「在工作台使用」把技能填入对话草稿。
              </p>
              {skills.length === 0 ? (
                <p className="text-[12px] text-ink-dim italic">未发现本地技能</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {skills.map((sk) => (
                    <div
                      key={sk.source + ':' + sk.path}
                      className="glass rounded-card border border-line p-3 flex flex-col"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[13px] text-ink font-medium truncate">{sk.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-chip bg-surface-2 text-ink-dim font-mono flex-shrink-0">
                          {sk.source}
                        </span>
                      </div>
                      <p className="text-[11.5px] text-ink-muted leading-4 line-clamp-3 flex-1">
                        {sk.description || '（无描述）'}
                      </p>
                      <button
                        onClick={() => {
                          onUseSkill(`请使用技能「${sk.name}」：${sk.description || sk.name}`)
                          onClose()
                        }}
                        className="mt-2 self-start text-[11px] px-2.5 py-1 rounded-md bg-surface-2 hover:bg-elevated border border-line text-ink transition-colors"
                      >
                        在工作台使用
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
