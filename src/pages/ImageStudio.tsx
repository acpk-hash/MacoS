// 图像板块 — 导航骨架占位页，生成界面由后续任务实现。

export default function ImageStudio() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-xl font-bold text-ink">图像</h1>
        <p className="mt-1 text-sm text-ink-muted">AI 图像生成</p>

        <div className="mt-8 rounded-card border border-dashed border-line bg-surface px-6 py-20 text-center">
          <p className="text-sm text-ink-dim">生成界面构建中</p>
        </div>
      </div>
    </div>
  )
}
