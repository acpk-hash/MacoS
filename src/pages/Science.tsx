// 科研板块 — 文献搜索 · 文献分析 · 知识库（idea 库） · idea 思考。
// 自动科研 tab 已迁往顶级 Auto 页（AutoResearchTab 组件文件保留,供 Auto 页使用）。
import { useEffect } from 'react'
import LitSearchTab from '../components/science/LitSearchTab'
import LibraryTab from '../components/science/LibraryTab'
import AnalysisTab from '../components/science/AnalysisTab'
import IdeaTab from '../components/science/IdeaTab'
import { useKbStore } from '../stores/kbStore'
import { useScienceStore, type SciTab } from '../stores/scienceStore'

export default function Science() {
  // tab 放 scienceStore:其他 tab 的「进入文献分析」可以直接切换,且切页返回不丢。
  const tab = useScienceStore((s) => s.activeTab)
  const setTab = useScienceStore((s) => s.setActiveTab)

  // 进入知识库 / idea 思考 tab 时拉取论文/分类/标签（与旧 Research 页一致）。
  useEffect(() => {
    if (tab === 'library' || tab === 'ideas') {
      const kb = useKbStore.getState()
      void kb.loadPapers()
      void kb.loadCategories()
      void kb.loadTags()
    }
  }, [tab])

  const TabButton = ({ id, label }: { id: SciTab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={
        'px-3 py-1.5 text-[13px] rounded-lg transition-colors ' +
        (tab === id
          ? 'bg-primary-tint text-primary font-semibold'
          : 'text-ink-dim hover:text-ink')
      }
    >
      {label}
    </button>
  )

  return (
    <div className="h-full flex flex-col text-ink">
      <header className="px-4 py-3 border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-bold text-ink mr-2">科研</h1>
          <TabButton id="lit" label="文献搜索" />
          <TabButton id="analysis" label="文献分析" />
          <TabButton id="library" label="知识库（idea 库）" />
          <TabButton id="ideas" label="idea 思考" />
        </div>
      </header>

      {tab === 'lit' && <LitSearchTab />}
      {tab === 'analysis' && <AnalysisTab />}
      {tab === 'library' && <LibraryTab />}
      {tab === 'ideas' && <IdeaTab />}
    </div>
  )
}
