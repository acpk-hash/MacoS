// 科研板块 — 文献搜索 · 知识库（idea 库）· 自动科研（open-science 集成）。
import { useEffect, useState } from 'react'
import LitSearchTab from '../components/science/LitSearchTab'
import LibraryTab from '../components/science/LibraryTab'
import AutoResearchTab from '../components/science/AutoResearchTab'
import { useKbStore } from '../stores/kbStore'

type SciTab = 'lit' | 'library' | 'auto'

export default function Science() {
  const [tab, setTab] = useState<SciTab>('lit')

  // 进入知识库 tab 时拉取论文/分类/标签（与旧 Research 页一致）。
  useEffect(() => {
    if (tab === 'library') {
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
          <TabButton id="library" label="知识库（idea 库）" />
          <TabButton id="auto" label="自动科研" />
        </div>
      </header>

      {tab === 'lit' && <LitSearchTab />}
      {tab === 'library' && <LibraryTab />}
      {tab === 'auto' && <AutoResearchTab />}
    </div>
  )
}
