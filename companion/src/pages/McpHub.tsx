import { useState } from 'react'

interface McpServer {
  id: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'error'
  command?: string
}

interface CatalogItem {
  id: string
  name: string
  category: string
  description: string
}

const INSTALLED: McpServer[] = [
  { id: '1', name: 'sqlite-server', description: '本地 SQLite 数据库查询与管理', status: 'running', command: 'npx @mcp/sqlite' },
  { id: '2', name: 'filesystem-server', description: '安全的本地文件系统读写操作', status: 'running', command: 'npx @mcp/filesystem' },
  { id: '3', name: 'brave-search', description: 'Brave Search API 网页检索', status: 'stopped', command: 'npx @mcp/brave-search' },
]

const CATALOG: CatalogItem[] = [
  { id: 'c1', name: 'SQLite', category: '数据库', description: '轻量级 SQL 数据库工具服务器' },
  { id: 'c2', name: 'Filesystem', category: '文件', description: '受控文件系统读写访问' },
  { id: 'c3', name: 'Brave Search', category: '搜索', description: '网页搜索与内容提取' },
  { id: 'c4', name: 'Supabase', category: '数据库', description: 'Supabase 项目管理与查询' },
]

const statusConfig: Record<McpServer['status'], { dot: string; label: string }> = {
  running: { dot: 'dot-ok', label: '运行中' },
  stopped: { dot: 'dot-off', label: '已停止' },
  error: { dot: 'dot-err', label: '错误' },
}

const categoryBadge: Record<string, string> = {
  '数据库': 'badge-sky',
  '文件': 'badge-gold',
  '搜索': 'badge-mint',
}

export default function McpHub() {
  const [showAddForm, setShowAddForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formEnv, setFormEnv] = useState('')

  return (
    <div className="page">
      <div className="page-header">
        <h1>{'MCP 工具服务器'}</h1>
        <p>{'管理模型上下文协议服务器'}</p>
      </div>
      <div className="page-body flex flex-col gap-4">
        {/* Installed servers */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">{'已安装'}</p>
            <span className="text-xs text-ink-faint">{INSTALLED.length} {'个服务器'}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {INSTALLED.map((srv) => {
              const sc = statusConfig[srv.status]
              return (
                <div key={srv.id} className="card animate-in">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-lg shrink-0">
                      {'\u{1F50C}'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-ink truncate">{srv.name}</p>
                        <span className={`dot ${sc.dot}`} />
                      </div>
                      <p className="text-xs text-ink-muted mt-0.5">{srv.description}</p>
                      {srv.command && (
                        <code className="text-[11px] text-ink-dim font-mono mt-1 block truncate">{srv.command}</code>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Add server */}
        <section>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="btn btn-secondary btn-block"
          >
            {showAddForm ? '取消' : '+ 添加服务器'}
          </button>

          {showAddForm && (
            <div className="card mt-3 flex flex-col gap-3 animate-in">
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'服务器名称'}</label>
                <input className="input" placeholder="my-server" value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'启动命令'}</label>
                <input className="input" placeholder="npx @mcp/my-server" value={formCommand} onChange={(e) => setFormCommand(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'参数 (可选)'}</label>
                <input className="input" placeholder="--port 3001" value={formArgs} onChange={(e) => setFormArgs(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-ink-muted block mb-1">{'环境变量 (可选)'}</label>
                <input className="input" placeholder="API_KEY=xxx" value={formEnv} onChange={(e) => setFormEnv(e.target.value)} />
              </div>
              <button onClick={() => alert('功能开发中')} className="btn btn-primary btn-block">{'保存'}</button>
            </div>
          )}
        </section>

        {/* Catalog */}
        <section>
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2 px-1">{'预设目录'}</p>
          <div className="flex flex-col gap-2.5">
            {CATALOG.map((item) => (
              <div key={item.id} className="card animate-in">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-lg shrink-0">
                    {'\u{1F4E6}'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-ink">{item.name}</p>
                      <span className={`badge ${categoryBadge[item.category] ?? 'badge-sky'}`}>{item.category}</span>
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">{item.description}</p>
                  </div>
                  <button onClick={() => alert('功能开发中')} className="btn btn-sm btn-primary shrink-0">{'安装'}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
