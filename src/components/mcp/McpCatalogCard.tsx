// 推荐目录 MCP 卡片：名称 / 描述 / npm 包名 / 分类 / 一键安装按钮。
import { Button, Chip } from '../ui'
import type { McpCatalogEntry } from '../../stores/mcpStore'

export interface McpCatalogCardProps {
  entry: McpCatalogEntry
  installed: boolean
  installing: boolean
  onInstall: (entry: McpCatalogEntry) => void
}

const categoryTone: Record<string, 'primary' | 'sky' | 'mint' | 'gold' | 'coral' | 'lavender' | 'neutral'> = {
  '文件系统': 'primary',
  '网络': 'sky',
  '代码': 'mint',
  '数据库': 'gold',
  '浏览器': 'coral',
  '思维': 'lavender',
  '云': 'sky',
  '效率': 'mint',
}

export default function McpCatalogCard({
  entry,
  installed,
  installing,
  onInstall,
}: McpCatalogCardProps) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3.5 hover:border-line-strong transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-ink" title={entry.name}>
            {entry.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint" title={entry.npm_package}>
            {entry.npm_package}
          </p>
        </div>
        {entry.category && (
          <Chip tone={categoryTone[entry.category] ?? 'neutral'}>{entry.category}</Chip>
        )}
      </div>

      <p
        className="text-[11.5px] leading-5 text-ink-muted line-clamp-3 min-h-[3.75rem]"
        title={entry.description}
      >
        {entry.description}
      </p>

      {entry.env_hints.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.env_hints.map(([k]) => (
            <Chip key={k} tone="gold">{k}</Chip>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-end gap-2 pt-1">
        {installed ? (
          <Chip tone="done">已安装</Chip>
        ) : (
          <Button
            size="sm"
            variant="soft"
            disabled={installing}
            onClick={() => onInstall(entry)}
          >
            {installing ? '安装中...' : '一键安装'}
          </Button>
        )}
      </div>
    </div>
  )
}
