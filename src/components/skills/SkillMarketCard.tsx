// 技能市场卡片：名称 / 描述 / 分类 chip / 安装按钮（已安装则置灰标记）。
import { Button, Chip } from '../ui'
import type { MarketEntry } from '../../stores/skillsStore'

export interface SkillMarketCardProps {
  entry: MarketEntry
  installed: boolean
  installing: boolean
  onInstall: (id: string) => void
}

export default function SkillMarketCard({
  entry,
  installed,
  installing,
  onInstall,
}: SkillMarketCardProps) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3.5 hover:border-line-strong transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-ink" title={entry.name}>
            {entry.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint" title={entry.id}>
            {entry.id}
          </p>
        </div>
        {entry.category && <Chip tone="primary">{entry.category}</Chip>}
      </div>

      <p
        className="text-[11.5px] leading-5 text-ink-muted line-clamp-3 min-h-[3.75rem]"
        title={entry.description}
      >
        {entry.description || '（无描述）'}
      </p>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <div className="flex min-w-0 flex-wrap gap-1">
          {entry.tags.slice(0, 3).map((t) => (
            <Chip key={t} tone="neutral">
              {t}
            </Chip>
          ))}
        </div>
        {installed ? (
          <Chip tone="done">已安装</Chip>
        ) : (
          <Button
            size="sm"
            variant="soft"
            disabled={installing}
            onClick={() => onInstall(entry.id)}
          >
            {installing ? '安装中…' : '安装'}
          </Button>
        )}
      </div>
    </div>
  )
}
