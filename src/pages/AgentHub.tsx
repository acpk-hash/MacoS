// Agent 板块 — V2 骨架占位：会话工作流的存档与复用中心。

export default function AgentHub() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-8 pt-10">
        <h1 className="text-xl font-bold text-ink">Agent</h1>
        <p className="mt-1 text-sm text-ink-muted">会话工作流存档与复用</p>
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
          <rect width="8" height="8" x="3" y="3" rx="2" />
          <path d="M7 11v4a2 2 0 0 0 2 2h4" />
          <rect width="8" height="8" x="13" y="13" rx="2" />
        </svg>
        <div className="text-center">
          <p className="text-3xl font-bold tracking-widest text-ink-muted">建设中</p>
          <p className="mt-3 text-sm text-ink-dim">敬请期待</p>
        </div>
      </div>
    </div>
  )
}
