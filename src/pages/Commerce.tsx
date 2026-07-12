// 跨境电商板块 — V2 骨架占位：选品 → 利润 → 图片 → 详情页 全流水线（顶级大类）。

export default function Commerce() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-8 pt-10">
        <h1 className="text-xl font-bold text-ink">跨境电商</h1>
        <p className="mt-1 text-sm text-ink-muted">选品分析 · 利润测算 · 图片生成 · 详情页包装 全流水线</p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 pb-24">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-14 w-14 text-ink-faint"
          aria-hidden="true"
        >
          <circle cx="8" cy="21" r="1" />
          <circle cx="19" cy="21" r="1" />
          <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
        </svg>
        <div className="text-center">
          <p className="text-3xl font-bold tracking-widest text-ink-muted">建设中</p>
          <p className="mt-3 text-sm text-ink-dim">敬请期待</p>
        </div>
      </div>
    </div>
  )
}
