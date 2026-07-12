// 处理中提示（流式进度），可附带已接收的增量文本预览。
export default function Spinner({
  label,
  streamText,
}: {
  label: string
  streamText?: string
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        {label}
      </div>
      {streamText ? (
        <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2.5 text-[11px] leading-relaxed text-ink-dim">
          {streamText.slice(-2000)}
        </pre>
      ) : null}
    </div>
  )
}
