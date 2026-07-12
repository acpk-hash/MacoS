// 视频板块 — 终态页面：暂不开放，居中留白式「待开放」占位。

export default function VideoStudio() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-8 pt-10">
        <h1 className="text-xl font-bold text-ink">视频</h1>
        <p className="mt-1 text-sm text-ink-muted">视频生成与处理</p>
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
          <path d="m22 8-6 4 6 4V8Z" />
          <rect x="2" y="6" width="14" height="12" rx="2" />
        </svg>
        <div className="text-center">
          <p className="text-3xl font-bold tracking-widest text-ink-muted">待开放</p>
          <p className="mt-3 text-sm text-ink-dim">敬请期待</p>
        </div>
      </div>
    </div>
  )
}
