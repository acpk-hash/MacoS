// Agent 板块 — 会话工作流的存档与复用中心。
// 数据来源：piStore 在每次 agent_end（非 willRetry）定稿时把会话快照推给
// agentHubStore 自动存档（同会话多轮更新同一条）。这里提供：
//   按天分组列表（搜索 / 删除 / 导出 .md）→ 详情抽屉（步骤时间线 + prompt 链）
//   → 复用（复制首轮 prompt / 在编码中重跑）。纯前端，localStorage 持久。
import { useEffect, useMemo, useState } from 'react'
import { saveExport } from '../lib/exportChat'
import { useAgentHubStore, workflowToMarkdown } from '../stores/agentHubStore'
import type { WorkflowRecord } from '../stores/agentHubStore'
import WorkflowCard from '../components/agenthub/WorkflowCard'
import WorkflowDrawer from '../components/agenthub/WorkflowDrawer'
import { groupByDay } from '../components/agenthub/workflowUtils'

export default function AgentHub() {
  const records = useAgentHubStore((s) => s.records)
  const removeRecord = useAgentHubStore((s) => s.removeRecord)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(null), 3000)
    return () => clearTimeout(t)
  }, [hint])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return records
    return records.filter((r) => {
      if (r.title.toLowerCase().includes(q)) return true
      if (r.cwd.toLowerCase().includes(q)) return true
      if (r.fullPromptChain.some((p) => p.toLowerCase().includes(q))) return true
      return r.steps.some((s) => s.summary.toLowerCase().includes(q))
    })
  }, [records, query])

  const groups = useMemo(() => groupByDay(filtered), [filtered])
  const selected = selectedId
    ? records.find((r) => r.id === selectedId) ?? null
    : null

  const handleExport = async (rec: WorkflowRecord) => {
    try {
      const ok = await saveExport(rec.title, 'md', workflowToMarkdown(rec))
      if (ok) setHint(`已导出「${rec.title}」`)
    } catch (e) {
      setHint(`导出失败：${String(e)}`)
    }
  }

  const handleDelete = (rec: WorkflowRecord) => {
    if (!window.confirm(`删除工作流存档「${rec.title}」？此操作不可恢复。`)) return
    removeRecord(rec.id)
    if (selectedId === rec.id) setSelectedId(null)
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* 头部：标题 + 搜索 */}
      <div className="w-full max-w-4xl mx-auto px-8 pt-10 pb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink">Agent</h1>
            <p className="mt-1 text-sm text-ink-muted">
              会话工作流存档与复用
              {records.length > 0 && <span> · 共 {records.length} 条</span>}
            </p>
          </div>
          <div className="flex-1" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 内容…"
            className="w-64 max-w-full px-3 py-1.5 rounded-input border border-line bg-editor text-[12px] text-ink placeholder:text-ink-faint outline-none focus:border-primary/60 transition-colors"
          />
        </div>
        {hint && <div className="mt-2 text-[11px] text-done">{hint}</div>}
      </div>

      {/* 列表 / 空态 */}
      <div className="flex-1 w-full max-w-4xl mx-auto px-8 pb-16">
        {records.length === 0 ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-4">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-12 w-12 text-ink-faint"
              aria-hidden="true"
            >
              <rect width="8" height="8" x="3" y="3" rx="2" />
              <path d="M7 11v4a2 2 0 0 0 2 2h4" />
              <rect width="8" height="8" x="13" y="13" rx="2" />
            </svg>
            <p className="text-sm text-ink-dim">
              完成一次编码会话后，工作流将自动在这里存档
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex min-h-[200px] items-center justify-center">
            <p className="text-sm text-ink-dim">没有匹配「{query.trim()}」的工作流</p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-6">
              <div className="mb-2 text-[11px] font-medium text-ink-dim select-none">
                {g.label}
              </div>
              <div className="space-y-2">
                {g.items.map((r) => (
                  <WorkflowCard
                    key={r.id}
                    rec={r}
                    onOpen={() => setSelectedId(r.id)}
                    onExport={() => void handleExport(r)}
                    onDelete={() => handleDelete(r)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 详情抽屉 */}
      {selected && (
        <WorkflowDrawer
          rec={selected}
          onClose={() => setSelectedId(null)}
          onExport={() => void handleExport(selected)}
          onDelete={() => handleDelete(selected)}
        />
      )}
    </div>
  )
}
