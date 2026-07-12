// 跨境电商板块 — 从选品到出图到 listing 的从业者流水线（五模块，左侧步骤导航
// 可任意进入）。一个产品一个项目（localStorage 持久），模块间引用同项目数据。
// 状态全部在 commerceStore：导航离开、后台任务都不丢。
import { useEffect, useState } from 'react'
import {
  useCommerceStore,
  type ChatSlot,
} from '../stores/commerceStore'
import ProductResearch from '../components/commerce/ProductResearch'
import ProfitCalc from '../components/commerce/ProfitCalc'
import InsightLab from '../components/commerce/InsightLab'
import ImageFactory from '../components/commerce/ImageFactory'
import ListingBuilder from '../components/commerce/ListingBuilder'
import { TrustBadge, inputCls, btnGhostCls, btnPrimaryCls } from '../components/commerce/ui'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

interface StepDef {
  n: number
  title: string
  sub: string
  /** 该步骤关联的 AI 槽位（用于运行中小圆点）。 */
  slots: ChatSlot[]
}

const STEPS: StepDef[] = [
  { n: 1, title: '选品分析', sub: '五维评分 · Go/No-Go', slots: ['research'] },
  { n: 2, title: '利润测算', sub: '毛利 · 净利 · 平衡ROAS', slots: [] },
  { n: 3, title: '评论&搜索词', sub: 'CSV 规则引擎 · 六维痛点', slots: ['insight', 'review'] },
  { n: 4, title: '产品图生成', sub: '8 图型 × 25 模板', slots: [] },
  { n: 5, title: 'Listing 构建', sub: '标题 · 五点 · A+ · ST', slots: ['listing'] },
]

export default function Commerce() {
  const {
    activeStep,
    setActiveStep,
    projects,
    activeProjectId,
    createProject,
    selectProject,
    renameProject,
    deleteProject,
    loadModels,
    slots,
    imagesGenerating,
  } = useCommerceStore()

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const project = projects.find((p) => p.id === activeProjectId) ?? null

  useEffect(() => {
    if (isTauri) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
        <p className="text-ink-dim text-xs">跨境电商板块需要 Tauri 桌面运行时。</p>
      </div>
    )
  }

  const stepRunning = (s: StepDef) =>
    s.slots.some((k) => slots[k].status === 'running') || (s.n === 4 && imagesGenerating)

  return (
    <div className="flex h-full min-h-0">
      {/* ── 左：项目 + 步骤导航 ── */}
      <aside className="w-[240px] flex-shrink-0 border-r border-line flex flex-col min-h-0">
        <div className="px-4 pt-5 pb-3">
          <h1 className="text-lg font-bold text-ink">跨境电商</h1>
          <p className="mt-0.5 text-xs text-ink-muted">选品 → 利润 → 洞察 → 出图 → Listing</p>
        </div>

        {/* 项目管理 */}
        <div className="px-4 pb-3 flex flex-col gap-2 border-b border-line">
          {projects.length > 0 && (
            <select
              value={activeProjectId ?? ''}
              onChange={(e) => selectProject(e.target.value)}
              className="w-full bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender"
              title="切换产品项目"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {renaming && project ? (
            <div className="flex gap-1.5">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    renameProject(project.id, renameValue)
                    setRenaming(false)
                  }
                  if (e.key === 'Escape') setRenaming(false)
                }}
                autoFocus
                className={inputCls + ' py-1 text-xs'}
              />
              <button
                onClick={() => {
                  renameProject(project.id, renameValue)
                  setRenaming(false)
                }}
                className={btnGhostCls}
              >
                ✓
              </button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <button onClick={() => createProject()} className={btnGhostCls + ' flex-1'}>
                + 新建产品
              </button>
              {project && (
                <>
                  <button
                    onClick={() => {
                      setRenameValue(project.name)
                      setRenaming(true)
                    }}
                    className={btnGhostCls}
                    title="重命名"
                  >
                    改名
                  </button>
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className={btnGhostCls + ' hover:text-failed'}
                    title="删除项目"
                  >
                    删
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 步骤导航 */}
        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-1">
          {STEPS.map((s) => (
            <button
              key={s.n}
              onClick={() => setActiveStep(s.n)}
              disabled={!project}
              className={
                'text-left rounded-lg px-3 py-2.5 border transition-colors disabled:opacity-40 ' +
                (activeStep === s.n
                  ? 'bg-accent-soft border-accent/30'
                  : 'border-transparent hover:bg-surface-2')
              }
            >
              <p className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span
                  className={
                    'inline-flex w-5 h-5 rounded-full items-center justify-center text-[11px] ' +
                    (activeStep === s.n ? 'bg-accent text-white' : 'bg-surface-2 text-ink-dim border border-line')
                  }
                >
                  {s.n}
                </span>
                {s.title}
                {stepRunning(s) && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-running animate-pulse" title="任务运行中" />
                )}
              </p>
              <p className="mt-0.5 pl-7 text-[10.5px] text-ink-dim">{s.sub}</p>
            </button>
          ))}
        </nav>

        {/* 可信度图例 */}
        <div className="px-4 py-3 border-t border-line flex flex-col gap-1.5">
          <p className="text-[10.5px] text-ink-faint">结果可信度标签</p>
          <div className="flex flex-wrap gap-1.5">
            <TrustBadge kind="ai" />
            <TrustBadge kind="local" />
            <TrustBadge kind="user" />
          </div>
        </div>
      </aside>

      {/* ── 右：当前模块 ── */}
      <section className="flex-1 min-w-0 overflow-y-auto">
        {!project ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-12 w-12 text-ink-faint"
              aria-hidden="true"
            >
              <circle cx="8" cy="21" r="1" />
              <circle cx="19" cy="21" r="1" />
              <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
            </svg>
            <div className="text-center">
              <p className="text-lg font-semibold text-ink">一个产品，一条流水线</p>
              <p className="mt-1.5 text-sm text-ink-dim max-w-md leading-relaxed">
                新建一个产品项目，从选品评分开始，到利润测算、真实数据洞察、
                批量出图，最后一键生成 Listing——所有产出留在项目里互相引用。
              </p>
            </div>
            <button onClick={() => createProject()} className={btnPrimaryCls}>
              新建产品项目
            </button>
          </div>
        ) : (
          <div className="px-6 py-5 max-w-[1100px]">
            <div className="mb-4 flex items-baseline gap-3">
              <h2 className="text-base font-semibold text-ink">
                {STEPS.find((s) => s.n === activeStep)?.title}
              </h2>
              <span className="text-xs text-ink-dim">项目：{project.name}</span>
            </div>
            {activeStep === 1 && <ProductResearch project={project} />}
            {activeStep === 2 && <ProfitCalc project={project} />}
            {activeStep === 3 && <InsightLab project={project} />}
            {activeStep === 4 && <ImageFactory project={project} />}
            {activeStep === 5 && <ListingBuilder project={project} />}
          </div>
        )}
      </section>

      {/* 删除确认 */}
      {confirmDelete && project && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface border border-line rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-ink mb-1 font-medium">删除项目「{project.name}」？</p>
            <p className="text-xs text-ink-dim mb-4">
              项目内的报告、方案、洞察与出图记录关联将被移除（已生成的图片文件仍保留在图像板块）。
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className={btnGhostCls}>
                取消
              </button>
              <button
                onClick={() => {
                  deleteProject(project.id)
                  setConfirmDelete(false)
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#d0342c] hover:bg-failed text-white border border-failed transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
