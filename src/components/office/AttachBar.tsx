// 附件条（办公窗口共用）：上传按钮 + 附件 chip 列表 + 警告行。
// 图片附件走多模态（chat_send image_url 内容块），文本附件由后端内联；
// 粘贴截图由宿主输入框的 onPaste 调 filesFromClipboard 转成 File 后走同一入口。
import { useRef } from 'react'
import type { Attachment } from '../../stores/studioStore'

/** 从粘贴事件里取出文件（截图粘贴 → image/png File）。 */
export function filesFromClipboard(e: React.ClipboardEvent): File[] {
  const files: File[] = []
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  return files
}

export default function AttachBar({
  attachments,
  warnings,
  onAdd,
  onRemove,
  disabled,
  accept,
  hint,
}: {
  attachments: Attachment[]
  warnings: string[]
  onAdd: (files: File[]) => void
  onRemove: (i: number) => void
  disabled?: boolean
  /** file input 的 accept；缺省不限。 */
  accept?: string
  hint?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className="rounded-chip border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted
                     transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
          title="上传附件（图片走多模态；txt/md/csv/docx 读取内容）"
        >
          📎 附件
        </button>
        {attachments.map((a, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-chip border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted"
            title={a.name}
          >
            {a.kind === 'image' ? '🖼' : '📄'}
            <span className="max-w-[160px] truncate">{a.name ?? '附件'}</span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="text-ink-dim hover:text-failed"
              title="移除"
            >
              ✕
            </button>
          </span>
        ))}
        {hint && <span className="text-[10px] text-ink-dim">{hint}</span>}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? [])
            if (fs.length > 0) onAdd(fs)
            e.target.value = ''
          }}
        />
      </div>
      {warnings.length > 0 && (
        <div className="text-[10px] leading-relaxed text-gold">
          {warnings.join('；')}
        </div>
      )}
    </div>
  )
}
