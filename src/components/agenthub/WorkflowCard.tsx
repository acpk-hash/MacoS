// AgentHub 列表卡片：标题 / 状态 / 模型 / 目录 / 步骤数 / 工具统计 chips /
// 相对时间；hover 显示「导出 .md / 删除」。点击卡片打开详情抽屉。
import type { WorkflowRecord } from '../../stores/agentHubStore'
import { STATUS_META, baseName, relativeTime, toolCounts } from './workflowUtils'

export default function WorkflowCard({
  rec,
  onOpen,
  onExport,
  onDelete,
}: {
  rec: WorkflowRecord
  onOpen: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const status = STATUS_META[rec.status]
  const tools = toolCounts(rec.steps)
  return (
    <div
      onClick={onOpen}
      className="group rounded-card border border-line bg-editor hover:border-line-strong shadow-card cursor-pointer px-4 py-3 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex-1 min-w-0 truncate text-[13px] font-medium text-ink"
          title={rec.title}
        >
          {rec.title}
        </span>
        <span
          className={`flex-shrink-0 px-1.5 py-0.5 rounded-chip border text-[10px] ${status.cls}`}
        >
          {status.label}
        </span>
        <span className="flex-shrink-0 text-[10.5px] text-ink-faint">
          {relativeTime(rec.finishedAt)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-2.5 text-[10.5px] text-ink-dim min-w-0">
        {rec.model && <span className="font-mono flex-shrink-0">{rec.model}</span>}
        <span className="truncate font-mono" title={rec.cwd}>
          {baseName(rec.cwd)}
        </span>
        <span className="flex-shrink-0">
          {rec.steps.length} 步 · {rec.fullPromptChain.length} 轮
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {tools.slice(0, 4).map((t) => (
          <span
            key={t.name}
            className="px-1.5 py-0.5 rounded-chip bg-surface-2 border border-line text-[10px] font-mono text-ink-muted"
          >
            {t.name}×{t.count}
          </span>
        ))}
        {tools.length > 4 && (
          <span className="text-[10px] text-ink-faint">+{tools.length - 4} 种</span>
        )}
        <div className="flex-1" />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onExport()
          }}
          className="opacity-0 group-hover:opacity-100 px-2 py-0.5 rounded-btn border border-line bg-surface text-[10.5px] text-ink-muted hover:text-ink hover:bg-surface-2 transition-all"
          title="把工作流导出为 Markdown 文件"
        >
          导出 .md
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="opacity-0 group-hover:opacity-100 px-2 py-0.5 rounded-btn border border-line bg-surface text-[10.5px] text-ink-muted hover:text-coral hover:border-coral/30 transition-all"
          title="删除此存档"
        >
          删除
        </button>
      </div>
    </div>
  )
}
