// 用量板块 — 导航骨架占位页，统计视图由后续任务实现。

export default function Usage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-xl font-bold text-ink">用量</h1>
        <p className="mt-1 text-sm text-ink-muted">Token 消耗与运行统计</p>

        <div className="mt-8 rounded-card border border-dashed border-line bg-surface px-6 py-20 text-center">
          <p className="text-sm text-ink-dim">统计视图构建中</p>
        </div>
      </div>
    </div>
  )
}
