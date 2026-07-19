import { useState } from 'react'

interface Workflow {
  id: string
  title: string
  date: string
  model: string
  status: 'running' | 'done' | 'error'
  messageCount: number
  steps?: string[]
}

const STATUS_CONFIG: Record<Workflow['status'], { badge: string; label: string }> = {
  running: { badge: 'badge-sky', label: '进行中' },
  done: { badge: 'badge-mint', label: '已完成' },
  error: { badge: 'badge-coral', label: '错误' },
}

const MOCK_WORKFLOWS: Workflow[] = [
  {
    id: '1',
    title: '重构用户认证模块',
    date: '2026-07-15 14:30',
    model: 'claude-opus-4',
    status: 'done',
    messageCount: 23,
    steps: ['分析现有认证代码', '设计新的 JWT 方案', '实现 token 刷新逻辑', '更新测试用例', '代码审查与合并'],
  },
  {
    id: '2',
    title: '数据库性能优化',
    date: '2026-07-16 09:15',
    model: 'gpt-5.5',
    status: 'running',
    messageCount: 12,
    steps: ['慢查询日志分析', '索引优化建议', '执行计划调整'],
  },
  {
    id: '3',
    title: '前端组件库升级',
    date: '2026-07-14 16:45',
    model: 'claude-sonnet-5',
    status: 'done',
    messageCount: 18,
    steps: ['依赖版本检查', '破坏性变更分析', '自动迁移脚本', '视觉回归测试'],
  },
  {
    id: '4',
    title: 'CI/CD 管道配置',
    date: '2026-07-13 11:00',
    model: 'gpt-5.5',
    status: 'error',
    messageCount: 8,
    steps: ['GitHub Actions 配置', 'Docker 镜像构建', '部署脚本编写'],
  },
  {
    id: '5',
    title: 'API 文档自动化',
    date: '2026-07-12 20:30',
    model: 'claude-opus-4',
    status: 'done',
    messageCount: 15,
    steps: ['解析路由定义', '生成 OpenAPI spec', '搭建文档站点'],
  },
]

type FilterTab = '全部' | '进行中' | '已完成'

const TAB_FILTER: Record<FilterTab, Workflow['status'] | null> = {
  '全部': null,
  '进行中': 'running',
  '已完成': 'done',
}

export default function AgentHub() {
  const [activeTab, setActiveTab] = useState<FilterTab>('全部')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = MOCK_WORKFLOWS.filter((w) => {
    const target = TAB_FILTER[activeTab]
    return target === null || w.status === target
  })

  return (
    <div className="page">
      <div className="page-header">
        <h1>{'Agent 工作流'}</h1>
        <p>{'管理与查看 AI 工作流归档'}</p>
      </div>
      <div className="page-body flex flex-col gap-3">
        {/* Filter tabs */}
        <div className="flex gap-2">
          {(Object.keys(TAB_FILTER) as FilterTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                activeTab === tab
                  ? 'bg-primary text-white'
                  : 'bg-surface-2 text-ink-muted'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Workflow list */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint animate-in">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p className="text-sm">{'暂无工作流'}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((wf) => {
              const sc = STATUS_CONFIG[wf.status]
              const isExpanded = expandedId === wf.id
              return (
                <div key={wf.id} className="card animate-in">
                  <button
                    className="w-full text-left"
                    onClick={() => setExpandedId(isExpanded ? null : wf.id)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-lg shrink-0">
                        {'\u{1F916}'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-ink truncate">{wf.title}</p>
                          <span className={`badge ${sc.badge}`}>{sc.label}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5">
                          <span className="text-[11px] text-ink-dim">{wf.date}</span>
                          <span className="text-[11px] text-ink-dim font-mono">{wf.model}</span>
                          <span className="text-[11px] text-ink-dim">{wf.messageCount} {'条消息'}</span>
                        </div>
                      </div>
                      <svg
                        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        className={`shrink-0 text-ink-faint transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && wf.steps && (
                    <div className="mt-3 pt-3 border-t border-line-soft animate-in">
                      <p className="text-xs font-semibold text-ink-dim mb-2">{'工作流步骤'}</p>
                      <div className="flex flex-col gap-1.5">
                        {wf.steps.map((step, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                              wf.status === 'done' || i < (wf.steps?.length ?? 0) - 1
                                ? 'bg-mint/10 text-mint'
                                : wf.status === 'error' && i === (wf.steps?.length ?? 0) - 1
                                  ? 'bg-coral/10 text-coral'
                                  : 'bg-sky/10 text-sky'
                            }`}>
                              {i + 1}
                            </span>
                            <span className="text-xs text-ink-muted">{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* FAB */}
      <button
        className="fixed bottom-20 right-4 w-14 h-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center active:bg-primary-hover transition-colors"
        style={{ bottom: 'calc(56px + env(safe-area-inset-bottom, 0px) + 16px)' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  )
}
