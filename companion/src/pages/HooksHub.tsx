import { useState } from 'react'

interface Hook {
  id: string
  name: string
  event: string
  enabled: boolean
  script?: string
}

const EVENT_TYPES = ['onFileChange', 'onSave', 'onCommit', 'onBuild'] as const

const EVENT_LABELS: Record<string, string> = {
  onFileChange: '文件变更',
  onSave: '保存',
  onCommit: '提交',
  onBuild: '构建',
}

const initialHooks: Hook[] = [
  { id: '1', name: '自动格式化', event: 'onSave', enabled: true, script: 'prettier --write $FILE' },
  { id: '2', name: 'Lint 检查', event: 'onCommit', enabled: true, script: 'eslint --fix .' },
  { id: '3', name: '类型检查', event: 'onBuild', enabled: false, script: 'tsc --noEmit' },
  { id: '4', name: '热重载通知', event: 'onFileChange', enabled: true, script: 'notify-send "File changed: $FILE"' },
]

export default function HooksHub() {
  const [hooks, setHooks] = useState<Hook[]>(initialHooks)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEvent, setNewEvent] = useState<string>(EVENT_TYPES[0])
  const [newScript, setNewScript] = useState('')

  function toggleHook(id: string) {
    setHooks((prev) =>
      prev.map((h) => (h.id === id ? { ...h, enabled: !h.enabled } : h))
    )
  }

  function handleAdd() {
    if (!newName.trim() || !newScript.trim()) return
    const hook: Hook = {
      id: String(Date.now()),
      name: newName.trim(),
      event: newEvent,
      enabled: true,
      script: newScript.trim(),
    }
    setHooks((prev) => [...prev, hook])
    setNewName('')
    setNewEvent(EVENT_TYPES[0])
    setNewScript('')
    setShowAdd(false)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{'编码钩子'}</h1>
        <p>{'管理开发工作流自动化钩子'}</p>
      </div>
      <div className="page-body flex flex-col gap-4">
        {/* Active hooks */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">{'已配置'}</p>
            <span className="text-xs text-ink-faint">{hooks.filter((h) => h.enabled).length} {'个启用'}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {hooks.map((hook) => (
              <div key={hook.id} className="card animate-in">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-lg shrink-0">
                    {'\u{1F517}'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-ink truncate">{hook.name}</p>
                      <span className="badge badge-gold">{EVENT_LABELS[hook.event] ?? hook.event}</span>
                    </div>
                    {hook.script && (
                      <code className="text-[11px] text-ink-dim font-mono mt-1 block truncate">{hook.script}</code>
                    )}
                  </div>
                  {/* Toggle switch */}
                  <button
                    onClick={() => toggleHook(hook.id)}
                    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                      hook.enabled ? 'bg-mint' : 'bg-line'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        hook.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Add hook */}
        <section>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="btn btn-secondary btn-block"
          >
            {showAdd ? '取消' : '+ 添加钩子'}
          </button>

          {showAdd && (
            <div className="card mt-3 flex flex-col gap-3 animate-in">
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'钩子名称'}</label>
                <input className="input" placeholder="例: 自动部署" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'触发事件'}</label>
                <select
                  value={newEvent}
                  onChange={(e) => setNewEvent(e.target.value)}
                  className="input"
                >
                  {EVENT_TYPES.map((ev) => (
                    <option key={ev} value={ev}>{EVENT_LABELS[ev]} ({ev})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'脚本内容'}</label>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="npm run deploy"
                  value={newScript}
                  onChange={(e) => setNewScript(e.target.value)}
                  style={{ resize: 'none' }}
                />
              </div>
              <button onClick={handleAdd} className="btn btn-primary btn-block">{'保存'}</button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
