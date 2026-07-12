// 办公板块 — PPT / Excel / Word 三个子窗口（页面内 tab 态切换）。
import { lazy, Suspense, useState } from 'react'

const PptWindow = lazy(() => import('../components/office/PptWindow'))
const ExcelWindow = lazy(() => import('../components/office/ExcelWindow'))
const WordWindow = lazy(() => import('../components/office/WordWindow'))

type ModuleKey = 'ppt' | 'excel' | 'word'

interface OfficeModule {
  key: ModuleKey
  title: string
  desc: string
}

const modules: OfficeModule[] = [
  {
    key: 'ppt',
    title: 'PPT 生成',
    desc: '先勾选方向选项，再按可编辑流程生成 HTML 演示文稿，可预览与导出',
  },
  {
    key: 'excel',
    title: 'Excel 处理',
    desc: '上传 xlsx/csv，自然语言指令修改数据，即时下载新版本',
  },
  {
    key: 'word',
    title: 'Word 文档',
    desc: '报告、信函与合同草稿的智能撰写，预览后一键导出 .docx',
  },
]

function ModuleCard({
  module,
  onClick,
}: {
  module: OfficeModule
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-card border border-line bg-surface
                 px-5 py-5 text-left transition-colors hover:border-primary hover:bg-surface-2"
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-semibold text-ink group-hover:text-primary transition-colors">
          {module.title}
        </span>
        <span className="rounded-chip border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-dim">
          进入 →
        </span>
      </div>
      <p className="text-xs leading-relaxed text-ink-muted">{module.desc}</p>
    </button>
  )
}

export default function Office() {
  const [active, setActive] = useState<ModuleKey | null>(null)
  const activeModule = modules.find((m) => m.key === active)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        {active == null ? (
          <>
            <h1 className="text-xl font-bold text-ink">办公</h1>
            <p className="mt-1 text-sm text-ink-muted">PPT · Excel · Word 智能处理</p>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {modules.map((m) => (
                <ModuleCard key={m.key} module={m} onClick={() => setActive(m.key)} />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mb-6 flex items-center gap-3">
              <button
                onClick={() => setActive(null)}
                className="rounded-btn border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted
                           transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink"
              >
                ← 办公
              </button>
              <h1 className="text-lg font-bold text-ink">{activeModule?.title}</h1>
            </div>
            <Suspense
              fallback={
                <div className="py-16 text-center text-sm text-ink-dim">加载中…</div>
              }
            >
              {active === 'ppt' && <PptWindow />}
              {active === 'excel' && <ExcelWindow />}
              {active === 'word' && <WordWindow />}
            </Suspense>
          </>
        )}
      </div>
    </div>
  )
}
