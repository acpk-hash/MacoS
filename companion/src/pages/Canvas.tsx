const TOOLBAR_ITEMS = [
  { icon: '□', label: '形状' },
  { icon: 'T', label: '文本' },
  { icon: '✎', label: '画笔' },
  { icon: '✖', label: '擦除' },
]

export default function Canvas() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>{'画布'}</h1>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 bg-editor border-b border-line-soft">
        {TOOLBAR_ITEMS.map((item) => (
          <button
            key={item.label}
            disabled
            className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg text-ink-faint cursor-not-allowed"
            title={item.label}
          >
            <span className="text-base">{item.icon}</span>
            <span className="text-[10px]">{item.label}</span>
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[10px] text-ink-faint font-mono">{'DEMO'}</span>
      </div>

      {/* Canvas area */}
      <div className="flex-1 relative overflow-hidden">
        {/* Grid background */}
        <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="grid-small" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--border-soft)" strokeWidth="0.5" />
            </pattern>
            <pattern id="grid-large" width="100" height="100" patternUnits="userSpaceOnUse">
              <rect width="100" height="100" fill="url(#grid-small)" />
              <path d="M 100 0 L 0 0 0 100" fill="none" stroke="var(--border)" strokeWidth="0.8" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="var(--surface)" />
          <rect width="100%" height="100%" fill="url(#grid-large)" />
        </svg>

        {/* Centered placeholder */}
        <div className="absolute inset-0 flex flex-col items-center justify-center animate-in">
          <div className="w-20 h-20 rounded-2xl bg-editor border border-line shadow-card flex items-center justify-center mb-4">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="1.2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-ink">{'画布功能即将支持触控操作'}</p>
          <p className="text-xs text-ink-dim mt-1.5 text-center max-w-[240px]">
            {'支持形状绘制、文本标注、自由画笔等功能，敬请期待'}
          </p>
          <div className="flex gap-2 mt-4">
            <span className="badge badge-mint">{'触控'}</span>
            <span className="badge badge-sky">{'手势'}</span>
            <span className="badge badge-gold">{'协作'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
