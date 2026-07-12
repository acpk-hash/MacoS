// Auto 板块 — V2 骨架占位：open-science 全流水线自动科研工作台。

export default function Auto() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-8 pt-10">
        <h1 className="text-xl font-bold text-ink">Auto 自动科研</h1>
        <p className="mt-1 text-sm text-ink-muted">open-science 全流水线工作台</p>
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
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
        <div className="text-center">
          <p className="text-3xl font-bold tracking-widest text-ink-muted">建设中</p>
          <p className="mt-3 text-sm text-ink-dim">正在从科研板块升级迁入，支持多样输入与全景预览</p>
        </div>
      </div>
    </div>
  )
}
