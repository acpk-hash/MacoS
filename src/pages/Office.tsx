// 办公板块 — 导航骨架占位页。三张能力卡片预留 onClick 挂载点，由后续任务填充实现。

interface OfficeModule {
  key: string
  title: string
  desc: string
  onClick: () => void
}

const modules: OfficeModule[] = [
  {
    key: 'ppt',
    title: 'PPT 生成',
    desc: '从主题或大纲出发，自动生成结构清晰的演示文稿',
    onClick: () => {}, // TODO: 后续任务接入 PPT 生成流程
  },
  {
    key: 'excel',
    title: 'Excel 处理',
    desc: '表格清洗、公式生成与数据分析，自然语言驱动',
    onClick: () => {}, // TODO: 后续任务接入 Excel 处理流程
  },
  {
    key: 'word',
    title: 'Word 文档',
    desc: '报告、合同与公文的智能撰写与排版',
    onClick: () => {}, // TODO: 后续任务接入 Word 文档流程
  },
]

function ModuleCard({ module }: { module: OfficeModule }) {
  return (
    <button
      onClick={module.onClick}
      className="group flex flex-col items-start gap-2 rounded-card border border-line bg-surface
                 px-5 py-5 text-left transition-colors hover:border-primary hover:bg-surface-2"
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-semibold text-ink group-hover:text-primary transition-colors">
          {module.title}
        </span>
        <span className="rounded-chip border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-dim">
          即将接入
        </span>
      </div>
      <p className="text-xs leading-relaxed text-ink-muted">{module.desc}</p>
    </button>
  )
}

export default function Office() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-xl font-bold text-ink">办公</h1>
        <p className="mt-1 text-sm text-ink-muted">PPT · Excel · Word 智能处理</p>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {modules.map((m) => (
            <ModuleCard key={m.key} module={m} />
          ))}
        </div>
      </div>
    </div>
  )
}
