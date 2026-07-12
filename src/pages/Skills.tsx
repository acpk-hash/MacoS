// Skills 板块 — V2 骨架占位：技能市场，下载即用，可在编码窗口唤起。

export default function Skills() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-8 pt-10">
        <h1 className="text-xl font-bold text-ink">Skills</h1>
        <p className="mt-1 text-sm text-ink-muted">技能市场 · 下载即用，编码窗口 / 唤起</p>
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
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />
        </svg>
        <div className="text-center">
          <p className="text-3xl font-bold tracking-widest text-ink-muted">建设中</p>
          <p className="mt-3 text-sm text-ink-dim">敬请期待</p>
        </div>
      </div>
    </div>
  )
}
