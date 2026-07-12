// 工作区结构化规则面板（P8 TRAP）
// 数据模型：.agentboard/rules.json（TRAP 四类）→ 编译写入 AGENTS.md 供 codex 读取。
// 只依赖已有 ws_read_file / ws_write_file Tauri 命令；绝不碰后端文件。
import { useEffect, useRef, useState } from 'react'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Rule,
  type RuleCategory,
  type RulesFile,
  compileToAgentsMd,
  defaultTemplateRules,
  genId,
} from '../../lib/rules'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

const RULES_JSON = '.agentboard/rules.json'
const AGENTS_MD = 'AGENTS.md'

// ── 单条规则卡片 ────────────────────────────────────────────────────────────
function RuleCard({
  rule,
  onChange,
  onDelete,
}: {
  rule: Rule
  onChange: (updated: Rule) => void
  onDelete: () => void
}) {
  const set = (patch: Partial<Rule>) => onChange({ ...rule, ...patch })
  return (
    <div
      className={`rounded-card border px-3 py-2.5 flex flex-col gap-1.5 transition-opacity ${
        rule.enabled ? 'border-line bg-surface' : 'border-line/50 bg-surface/40 opacity-60'
      }`}
    >
      {/* 头部：开关 + title + 删除 */}
      <div className="flex items-center gap-2">
        {/* 开关 */}
        <button
          title={rule.enabled ? '点击停用' : '点击启用'}
          onClick={() => set({ enabled: !rule.enabled })}
          className={`relative flex-shrink-0 w-7 h-4 rounded-full transition-colors ${
            rule.enabled ? 'bg-[#8b7cff]' : 'bg-surface-2 border border-line'
          }`}
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
              rule.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </button>
        {/* title 内联编辑 */}
        <input
          value={rule.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="规则名称"
          className="flex-1 min-w-0 bg-transparent text-[12px] font-medium text-ink placeholder:text-ink-faint focus:outline-none border-b border-transparent focus:border-line-strong transition-colors"
        />
        {/* 删除 */}
        <button
          onClick={onDelete}
          title="删除规则"
          className="flex-shrink-0 text-[11px] text-ink-faint hover:text-coral transition-colors px-1"
        >
          ✕
        </button>
      </div>
      {/* body 内联编辑 */}
      <textarea
        value={rule.body}
        onChange={(e) => set({ body: e.target.value })}
        placeholder="规则内容…"
        rows={3}
        spellCheck={false}
        className="w-full resize-y bg-editor border border-line rounded-input px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none focus:border-line-strong transition-colors"
      />
    </div>
  )
}

// ── 主面板 ────────────────────────────────────────────────────────────────────
export default function RulesPane() {
  const root = useWorkspaceStore((s) => s.root)
  const remote = useWorkspaceStore((s) => s.remote)

  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // 已持久化的规则 JSON（用于判断 dirty）
  const [savedJson, setSavedJson] = useState('')
  // 高级原文模式
  const [advancedText, setAdvancedText] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedDirty, setAdvancedDirty] = useState(false)
  // 预览折叠
  const [previewOpen, setPreviewOpen] = useState(false)

  const advancedBaseRef = useRef('') // 上次编译基准，用于检测手动改动

  // ── 加载 ──
  useEffect(() => {
    if (!isTauri || !root || remote) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setAdvancedDirty(false)
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      try {
        // 尝试读结构化规则
        const res = await invoke<{ content: string; too_large: boolean }>('ws_read_file', {
          relPath: RULES_JSON,
        })
        if (cancelled) return
        if (!res.too_large) {
          const parsed: RulesFile = JSON.parse(res.content)
          const loaded = parsed.rules ?? []
          setRules(loaded)
          const j = JSON.stringify({ version: 1, rules: loaded }, null, 2)
          setSavedJson(j)
          const compiled = compileToAgentsMd(loaded)
          setAdvancedText(compiled)
          advancedBaseRef.current = compiled
        }
      } catch {
        // rules.json 不存在 → 看 AGENTS.md 是否有内容需要迁移
        if (cancelled) return
        try {
          const mdRes = await invoke<{ content: string; too_large: boolean }>('ws_read_file', {
            relPath: AGENTS_MD,
          })
          if (cancelled) return
          const mdContent = !mdRes.too_large ? mdRes.content.trim() : ''
          if (mdContent) {
            // 迁移：包装成一条 approach 规则
            const migrated: Rule[] = [
              {
                id: genId(),
                category: 'approach',
                title: '导入的现有规则',
                body: mdContent,
                enabled: true,
              },
            ]
            setRules(migrated)
            setSavedJson('') // 尚未持久化到 json，标记为 dirty
            const compiled = compileToAgentsMd(migrated)
            setAdvancedText(compiled)
            advancedBaseRef.current = compiled
          } else {
            setRules([])
            setSavedJson(JSON.stringify({ version: 1, rules: [] }, null, 2))
            setAdvancedText('')
            advancedBaseRef.current = ''
          }
        } catch {
          if (cancelled) return
          setRules([])
          setSavedJson(JSON.stringify({ version: 1, rules: [] }, null, 2))
          setAdvancedText('')
          advancedBaseRef.current = ''
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, remote])

  // 同步高级原文（规则卡片变化时，若高级未手动改动则同步）
  useEffect(() => {
    if (!advancedDirty) {
      const compiled = compileToAgentsMd(rules)
      setAdvancedText(compiled)
      advancedBaseRef.current = compiled
    }
  }, [rules, advancedDirty])

  const currentJson = JSON.stringify({ version: 1, rules }, null, 2)
  const dirty = currentJson !== savedJson

  // ── 保存 ──
  const save = async () => {
    if (!isTauri || !root || saving) return
    setSaving(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const rulesJson = JSON.stringify({ version: 1, rules }, null, 2)
      await invoke('ws_write_file', { relPath: RULES_JSON, content: rulesJson })
      const agentsMdContent = advancedDirty ? advancedText : compileToAgentsMd(rules)
      await invoke('ws_write_file', { relPath: AGENTS_MD, content: agentsMdContent })
      setSavedJson(rulesJson)
      if (!advancedDirty) {
        advancedBaseRef.current = agentsMdContent
      }
      useWorkspaceStore.setState({ notice: '规则已保存（AGENTS.md 已同步更新）' })
    } catch (e) {
      useWorkspaceStore.setState({ error: `保存规则失败：${String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  // ── 规则操作 ──
  const updateRule = (id: string, updated: Rule) =>
    setRules((prev) => prev.map((r) => (r.id === id ? updated : r)))
  const deleteRule = (id: string) => setRules((prev) => prev.filter((r) => r.id !== id))
  const addRule = (category: RuleCategory) =>
    setRules((prev) => [
      ...prev,
      { id: genId(), category, title: '', body: '', enabled: true },
    ])

  const insertTemplates = () => setRules(defaultTemplateRules())

  // ── 远程模式 ──
  if (remote) {
    return (
      <p className="text-[12px] text-ink-dim text-center mt-6">
        远程模式下暂不支持编辑工作区规则（规则文件位于本地工作根）。
      </p>
    )
  }

  const compiled = compileToAgentsMd(rules)
  const totalEnabled = rules.filter((r) => r.enabled).length

  return (
    <div className="flex flex-col h-full min-h-0 gap-2 pb-2">
      {/* ── 顶部操作栏 ── */}
      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
        <span className="text-[11px] text-ink-dim font-mono" title={`${root ?? ''}/${RULES_JSON}`}>
          TRAP 规则
        </span>
        <span className="text-[11px] text-ink-faint">
          {loading ? '加载中…' : `${totalEnabled} 条启用 · 编译写入 AGENTS.md`}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setPreviewOpen((v) => !v)}
          className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-btn px-2 py-1 transition-colors"
        >
          {previewOpen ? '收起预览' : '预览 AGENTS.md'}
        </button>
        <button
          onClick={() => void save()}
          disabled={!dirty || saving || loading}
          className="text-[11px] text-white bg-grad-primary rounded-btn px-2.5 py-1 transition-all disabled:opacity-35"
        >
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
      </div>

      {/* ── 编译预览折叠区 ── */}
      {previewOpen && (
        <div className="flex-shrink-0 rounded-card border border-line bg-editor px-3 py-2">
          <p className="text-[10px] text-ink-faint mb-1">编译后的 AGENTS.md（只读预览）</p>
          <pre className="font-mono text-[10px] leading-relaxed text-ink-muted whitespace-pre-wrap max-h-40 overflow-y-auto">
            {compiled || '（无启用规则，AGENTS.md 将为空）'}
          </pre>
        </div>
      )}

      {/* ── 规则卡片主体（可滚动） ── */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-0.5">
        {/* 空状态引导 */}
        {!loading && rules.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-[12px] text-ink-dim">
              还没有规则。用 TRAP 框架沉淀团队约定：
            </p>
            <p className="text-[11px] text-ink-faint max-w-xs">
              <span className="text-[#8b7cff] font-medium">T</span>ools 工具约束 ·{' '}
              <span className="text-[#8b7cff] font-medium">R</span>ole 角色设定 ·{' '}
              <span className="text-[#8b7cff] font-medium">A</span>pproach 方法流程 ·{' '}
              <span className="text-[#8b7cff] font-medium">P</span>olicy 红线策略
            </p>
            <button
              onClick={insertTemplates}
              className="text-[11px] text-white bg-grad-primary rounded-btn px-3 py-1.5 transition-all hover:opacity-90"
            >
              一键插入 TRAP 示例模板
            </button>
          </div>
        )}

        {/* 四类分组 */}
        {CATEGORY_ORDER.map((cat) => {
          const catRules = rules.filter((r) => r.category === cat)
          return (
            <div key={cat} className="flex flex-col gap-1.5">
              {/* 分组标题 */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-[#8b7cff] uppercase tracking-wider">
                  {CATEGORY_LABELS[cat]}
                </span>
                <span className="text-[10px] text-ink-faint">
                  {catRules.filter((r) => r.enabled).length}/{catRules.length}
                </span>
                <div className="flex-1 h-px bg-line/50" />
              </div>
              {/* 规则卡片 */}
              {catRules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  onChange={(updated) => updateRule(rule.id, updated)}
                  onDelete={() => deleteRule(rule.id)}
                />
              ))}
              {/* 添加按钮 */}
              <button
                onClick={() => addRule(cat)}
                className="text-[11px] text-ink-faint hover:text-ink border border-dashed border-line/60 hover:border-line rounded-card px-3 py-1.5 transition-colors text-left"
              >
                ＋ 添加{CATEGORY_LABELS[cat]}规则
              </button>
            </div>
          )
        })}
      </div>

      {/* ── 高级：直接编辑原文（折叠） ── */}
      <div className="flex-shrink-0 border-t border-line/40 pt-2">
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="text-[11px] text-ink-faint hover:text-ink-muted transition-colors flex items-center gap-1"
        >
          <span className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}>▶</span>
          高级：直接编辑 AGENTS.md 原文
          {advancedDirty && (
            <span className="ml-1 text-[#8b7cff] text-[10px]">（原文已改动，保存时以此为准）</span>
          )}
        </button>
        {advancedOpen && (
          <div className="mt-1.5 flex flex-col gap-1">
            {advancedDirty && (
              <p className="text-[10px] text-gold/80 bg-gold/10 border border-gold/20 rounded-input px-2 py-1">
                注意：原文已被手动修改，保存时将以原文为准写入 AGENTS.md，结构化卡片的改动不会覆盖它。若要恢复结构化同步，请清空原文或点击下方「重置为编译结果」。
              </p>
            )}
            <textarea
              value={advancedText}
              onChange={(e) => {
                setAdvancedText(e.target.value)
                setAdvancedDirty(e.target.value !== advancedBaseRef.current)
              }}
              spellCheck={false}
              rows={8}
              placeholder="（从结构化规则编译而来，可手动覆盖）"
              className="w-full resize-y bg-editor border border-line rounded-card px-3 py-2 font-mono text-[11px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
            />
            {advancedDirty && (
              <button
                onClick={() => {
                  const compiled2 = compileToAgentsMd(rules)
                  setAdvancedText(compiled2)
                  advancedBaseRef.current = compiled2
                  setAdvancedDirty(false)
                }}
                className="self-end text-[10px] text-ink-faint hover:text-ink border border-line rounded-btn px-2 py-0.5 transition-colors"
              >
                重置为编译结果
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}