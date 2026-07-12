// 已安装 MCP 服务器卡片：名称 / 命令 / 参数 / 可折叠 env / 删除按钮。
import { useState } from 'react'
import { Button, Chip } from '../ui'
import type { McpServer } from '../../stores/mcpStore'

export interface McpInstalledCardProps {
  server: McpServer
  removing: boolean
  onRemove: (name: string) => void
}

export default function McpInstalledCard({
  server,
  removing,
  onRemove,
}: McpInstalledCardProps) {
  const [expanded, setExpanded] = useState(false)
  const envKeys = Object.keys(server.env)

  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3.5 hover:border-line-strong transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-done flex-shrink-0" />
            <p className="truncate text-[13px] font-semibold text-ink" title={server.name}>
              {server.name}
            </p>
          </div>
          <p className="mt-1 font-mono text-[10.5px] text-ink-faint truncate" title={`${server.command} ${server.args.join(' ')}`}>
            {server.command} {server.args.join(' ')}
          </p>
        </div>
        <Button
          size="sm"
          variant="danger"
          disabled={removing}
          onClick={() => onRemove(server.name)}
        >
          {removing ? '删除中...' : '删除'}
        </Button>
      </div>

      {envKeys.length > 0 && (
        <div>
          <button
            className="text-[10.5px] text-ink-dim hover:text-ink-muted transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : '展开'} 环境变量 ({envKeys.length})
          </button>
          {expanded && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {envKeys.map((k) => (
                <Chip key={k} tone="neutral">
                  {k}={server.env[k] ? '***' : '(空)'}
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
