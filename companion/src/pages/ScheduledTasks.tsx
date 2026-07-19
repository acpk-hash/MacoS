import { useState } from 'react'

const mockTasks = [
  { id: 1, name: '每日文献更新', cron: '0 8 * * *', nextRun: '2026-07-17 08:00', lastResult: 'success' as const, enabled: true },
  { id: 2, name: '每周研究报告生成', cron: '0 10 * * 1', nextRun: '2026-07-21 10:00', lastResult: 'success' as const, enabled: true },
  { id: 3, name: '数据备份', cron: '0 2 * * *', nextRun: '2026-07-17 02:00', lastResult: 'fail' as const, enabled: false },
  { id: 4, name: 'API 健康检查', cron: '*/30 * * * *', nextRun: '2026-07-16 15:30', lastResult: 'success' as const, enabled: true },
]

const mockHistory = [
  { id: 1, task: 'API 健康检查', time: '2026-07-16 15:00', duration: '2s', status: 'success' as const },
  { id: 2, task: '每日文献更新', time: '2026-07-16 08:00', duration: '45s', status: 'success' as const },
  { id: 3, task: '数据备份', time: '2026-07-16 02:00', duration: '12s', status: 'fail' as const },
  { id: 4, task: 'API 健康检查', time: '2026-07-16 14:30', duration: '1s', status: 'success' as const },
  { id: 5, task: 'API 健康检查', time: '2026-07-16 14:00', duration: '2s', status: 'success' as const },
]

const presets = [
  { label: '每小时', cron: '0 * * * *' },
  { label: '每天', cron: '0 8 * * *' },
  { label: '每周', cron: '0 10 * * 1' },
  { label: '自定义', cron: '' },
]

const actionTypes = ['AI 对话', 'HTTP 请求', '自定义脚本']

export default function ScheduledTasks() {
  const [tasks, setTasks] = useState(mockTasks)
  const [showForm, setShowForm] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [cronExpr, setCronExpr] = useState('0 * * * *')
  const [activePreset, setActivePreset] = useState(0)
  const [actionType, setActionType] = useState(actionTypes[0])
  const [actionConfig, setActionConfig] = useState('')

  function toggleTask(id: number) {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t))
    )
  }

  function handleCreate() {
    if (!taskName.trim()) return
    setTasks((prev) => [
      ...prev,
      { id: Date.now(), name: taskName, cron: cronExpr, nextRun: '', lastResult: 'success' as const, enabled: false },
    ])
    setTaskName('')
    setCronExpr('0 * * * *')
    setActionConfig('')
    setShowForm(false)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>定时任务</h1>
        <p>Cron 计划执行</p>
      </div>

      <div className="page-body">
        {/* Active Tasks */}
        <div className="card animate-in">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-ink">活跃任务</h2>
            <button
              onClick={() => setShowForm(!showForm)}
              className="btn btn-sm btn-secondary"
            >
              {showForm ? '取消' : '新建任务'}
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {tasks.map((task) => (
              <div key={task.id} className="card-flat p-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium leading-snug ${task.enabled ? 'text-ink' : 'text-ink-dim'}`}>
                      {task.name}
                    </p>
                    <code className="text-[11px] text-ink-muted font-mono mt-0.5 block">
                      {task.cron}
                    </code>
                  </div>
                  {/* Toggle */}
                  <button
                    onClick={() => toggleTask(task.id)}
                    className={`
                      relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0
                      ${task.enabled ? 'bg-primary' : 'bg-line'}
                    `}
                  >
                    <span
                      className={`
                        absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200
                        ${task.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}
                      `}
                    />
                  </button>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-dim">下次: {task.nextRun}</span>
                  <span className={`font-semibold px-2 py-0.5 rounded-full text-[10px] ${
                    task.lastResult === 'success' ? 'badge-mint' : 'badge-coral'
                  }`}>
                    {task.lastResult === 'success' ? '成功' : '失败'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Create Form */}
        {showForm && (
          <div className="card animate-in">
            <h2 className="text-sm font-semibold text-ink mb-3">新建任务</h2>

            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs font-medium text-ink-muted block mb-1">任务名称</label>
                <input
                  type="text"
                  value={taskName}
                  onChange={(e) => setTaskName(e.target.value)}
                  placeholder="输入任务名称..."
                  className="input w-full"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted block mb-1">执行频率</label>
                <div className="flex gap-1.5 mb-2">
                  {presets.map((p, i) => (
                    <button
                      key={p.label}
                      onClick={() => {
                        setActivePreset(i)
                        if (p.cron) setCronExpr(p.cron)
                      }}
                      className={`btn btn-sm flex-1 ${activePreset === i ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="Cron 表达式 (e.g. 0 * * * *)"
                  className="input w-full font-mono text-sm"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted block mb-1">执行类型</label>
                <div className="flex gap-1.5">
                  {actionTypes.map((a) => (
                    <button
                      key={a}
                      onClick={() => setActionType(a)}
                      className={`btn btn-sm flex-1 ${actionType === a ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted block mb-1">执行配置</label>
                <textarea
                  value={actionConfig}
                  onChange={(e) => setActionConfig(e.target.value)}
                  placeholder={
                    actionType === 'AI 对话'
                      ? '输入 AI 对话提示词...'
                      : actionType === 'HTTP 请求'
                        ? '输入请求 URL 和参数...'
                        : '输入脚本内容...'
                  }
                  rows={3}
                  className="input w-full resize-none"
                />
              </div>

              <button onClick={handleCreate} className="btn btn-primary btn-block">
                创建
              </button>
            </div>
          </div>
        )}

        {/* Execution History */}
        <div className="card animate-in" style={{ animationDelay: '60ms' }}>
          <h2 className="text-sm font-semibold text-ink mb-3">执行历史</h2>
          <div className="flex flex-col gap-2">
            {mockHistory.map((h) => (
              <div key={h.id} className="card-flat p-3 flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{h.task}</p>
                  <div className="flex items-center gap-2 text-xs text-ink-dim mt-0.5">
                    <span>{h.time}</span>
                    <span>耗时 {h.duration}</span>
                  </div>
                </div>
                <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  h.status === 'success' ? 'badge-mint' : 'badge-coral'
                }`}>
                  {h.status === 'success' ? '成功' : '失败'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
