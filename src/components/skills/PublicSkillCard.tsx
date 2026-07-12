// 公开搜索结果卡片：名称 / 描述 / 作者 / stars / topics / 安装按钮。
import { Button, Chip } from '../ui'
import type { PublicSkill } from '../../stores/skillsStore'

export interface PublicSkillCardProps {
  skill: PublicSkill
  installed: boolean
  installing: boolean
  onInstall: () => void
}

export default function PublicSkillCard({
  skill,
  installed,
  installing,
  onInstall,
}: PublicSkillCardProps) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3.5 hover:border-line-strong transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-ink" title={skill.name}>
            {skill.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint" title={skill.id}>
            {skill.author}/{skill.name}
          </p>
        </div>
        {skill.stars > 0 && (
          <span className="flex-shrink-0 text-[11px] text-ink-muted" title="GitHub stars">
            {skill.stars.toLocaleString()} stars
          </span>
        )}
      </div>

      <p
        className="text-[11.5px] leading-5 text-ink-muted line-clamp-3 min-h-[3.75rem]"
        title={skill.description}
      >
        {skill.description || '(no description)'}
      </p>

      <div className="flex min-w-0 flex-wrap gap-1">
        {skill.topics.slice(0, 4).map((t) => (
          <Chip key={t} tone="neutral">
            {t}
          </Chip>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <a
          href={skill.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-[11px] text-primary hover:underline"
          title={skill.source_url}
        >
          GitHub
        </a>
        <div className="flex items-center gap-1.5">
          {installed ? (
            <Chip tone="done">已安装</Chip>
          ) : skill.install_url ? (
            <Button
              size="sm"
              variant="soft"
              disabled={installing}
              onClick={onInstall}
            >
              {installing ? '安装中…' : '安装'}
            </Button>
          ) : (
            <span className="text-[11px] text-ink-dim">手动克隆</span>
          )}
        </div>
      </div>
    </div>
  )
}