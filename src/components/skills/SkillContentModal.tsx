// 已安装 skill 的 SKILL.md 预览弹层（MarkdownLite 渲染，白色主题）。
import { MarkdownLite } from '../ui/MarkdownLite'
import { Button } from '../ui'

export interface SkillContentModalProps {
  name: string
  content: string
  loading: boolean
  onClose: () => void
}

export default function SkillContentModal({
  name,
  content,
  loading,
  onClose,
}: SkillContentModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-ink">{name} · SKILL.md</p>
            <p className="font-mono text-[10.5px] text-ink-faint">/skill:{name}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="overflow-y-auto px-4 py-3 text-[12.5px] text-ink">
          {loading ? (
            <p className="text-ink-muted">加载中…</p>
          ) : (
            <MarkdownLite text={content} />
          )}
        </div>
      </div>
    </div>
  )
}
