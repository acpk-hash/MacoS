import { useState } from 'react'

const pipelineStages = [
  { id: 1, icon: '📥', name: '数据收集', desc: '从多个学术数据库自动抓取相关文献与数据集', status: 'done' as const },
  { id: 2, icon: '🔍', name: '文献检索', desc: '基于关键词和引用网络进行深度文献检索', status: 'running' as const },
  { id: 3, icon: '📝', name: '综述撰写', desc: 'AI 自动生成结构化的文献综述初稿', status: 'awaiting' as const },
  { id: 4, icon: '📊', name: '数据分析', desc: '对收集的数据进行统计分析与可视化', status: 'awaiting' as const },
  { id: 5, icon: '📄', name: '论文生成', desc: '根据分析结果自动生成论文草稿', status: 'awaiting' as const },
]

const statusConfig: Record<string, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'badge-mint' },
  running: { label: '运行中', cls: 'badge-sky' },
  awaiting: { label: '等待中', cls: 'badge-gold' },
  failed: { label: '失败', cls: 'badge-coral' },
}

const mockRuns = [
  { id: 1, topic: '深度学习在蛋白质结构预测中的应用', date: '2026-07-14', stages: '5/5', status: 'done' as const },
  { id: 2, topic: '可持续能源材料的机器学习筛选', date: '2026-07-12', stages: '3/5', status: 'running' as const },
  { id: 3, topic: '自然语言处理在法律文本分析中的进展', date: '2026-07-09', stages: '5/5', status: 'done' as const },
]

const journals = ['Nature', 'Science', 'IEEE', 'ACM', 'Elsevier', '中文核心期刊']

export default function Auto() {
  const [topic, setTopic] = useState('')
  const [journal, setJournal] = useState(journals[0])
  const [lang, setLang] = useState<'zh' | 'en'>('zh')

  return (
    <div className="page">
      <div className="page-header">
        <h1>Auto</h1>
        <p>open-science 全流水线自动科研</p>
      </div>

      <div className="page-body">
        {/* Pipeline Visualization */}
        <div className="card animate-in">
          <h2 className="text-sm font-semibold text-ink mb-4">流水线阶段</h2>

          <div className="flex flex-col">
            {pipelineStages.map((stage, i) => {
              const cfg = statusConfig[stage.status]
              return (
                <div key={stage.id} className="flex gap-3">
                  {/* Vertical connector */}
                  <div className="flex flex-col items-center">
                    <div
                      className={`
                        w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0
                        ${stage.status === 'done'
                          ? 'bg-done/10'
                          : stage.status === 'running'
                            ? 'bg-running/10'
                            : 'bg-surface-2'
                        }
                      `}
                    >
                      {stage.icon}
                      {stage.status === 'running' && (
                        <span className="absolute w-10 h-10 rounded-xl bg-running/10 animate-ping" />
                      )}
                    </div>
                    {i < pipelineStages.length - 1 && (
                      <div
                        className={`w-0.5 h-6 my-1 rounded ${
                          stage.status === 'done' ? 'bg-done/40' : 'bg-line'
                        }`}
                      />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 pb-4">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-ink">{stage.name}</h3>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>
                        {cfg.label}
                      </span>
                    </div>
                    <p className="text-xs text-ink-muted leading-relaxed">{stage.desc}</p>
                  </div>
                </div>
              )
            })}
          </div>

          <button className="btn btn-primary btn-block mt-2">启动流水线</button>
        </div>

        {/* Config */}
        <div className="card animate-in" style={{ animationDelay: '60ms' }}>
          <h2 className="text-sm font-semibold text-ink mb-3">流水线配置</h2>

          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs font-medium text-ink-muted block mb-1">研究课题</label>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="输入研究课题..."
                className="input w-full"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-ink-muted block mb-1">目标期刊</label>
              <select
                value={journal}
                onChange={(e) => setJournal(e.target.value)}
                className="input w-full"
              >
                {journals.map((j) => (
                  <option key={j} value={j}>{j}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-ink-muted block mb-1">论文语言</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setLang('zh')}
                  className={`btn btn-sm flex-1 ${lang === 'zh' ? 'btn-primary' : 'btn-secondary'}`}
                >
                  中文
                </button>
                <button
                  onClick={() => setLang('en')}
                  className={`btn btn-sm flex-1 ${lang === 'en' ? 'btn-primary' : 'btn-secondary'}`}
                >
                  English
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Status Dashboard */}
        <div className="card animate-in" style={{ animationDelay: '120ms' }}>
          <h2 className="text-sm font-semibold text-ink mb-3">运行状态</h2>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="card-flat p-3 text-center">
              <div className="text-2xl font-bold text-running">1</div>
              <div className="text-xs text-ink-muted mt-0.5">运行中</div>
            </div>
            <div className="card-flat p-3 text-center">
              <div className="text-2xl font-bold text-done">2</div>
              <div className="text-xs text-ink-muted mt-0.5">已完成</div>
            </div>
          </div>

          <h3 className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2">近期运行</h3>
          <div className="flex flex-col gap-2">
            {mockRuns.map((run) => {
              const cfg = statusConfig[run.status]
              return (
                <div key={run.id} className="card-flat p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-sm font-medium text-ink leading-snug flex-1">{run.topic}</p>
                    <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>
                      {cfg.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-ink-dim">
                    <span>{run.date}</span>
                    <span>阶段 {run.stages}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
