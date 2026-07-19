import { useState } from 'react'

const mockPapers = [
  { id: 1, title: 'Attention Is All You Need', authors: 'Vaswani et al.', year: 2017, source: 'arXiv' },
  { id: 2, title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: 'Devlin et al.', year: 2019, source: 'arXiv' },
  { id: 3, title: 'Language Models are Few-Shot Learners', authors: 'Brown et al.', year: 2020, source: 'arXiv' },
  { id: 4, title: 'Scaling Laws for Neural Language Models', authors: 'Kaplan et al.', year: 2020, source: 'eprint' },
]

const mockIdeas = [
  { id: 1, title: '基于图神经网络的文献引用关系建模', status: 'active' as const, date: '2026-07-15' },
  { id: 2, title: '跨语言学术摘要自动生成', status: 'done' as const, date: '2026-07-12' },
  { id: 3, title: 'LLM 辅助的系统性综述方法论', status: 'active' as const, date: '2026-07-10' },
  { id: 4, title: '科研数据集自动标注流水线', status: 'draft' as const, date: '2026-07-08' },
]

const statusConfig: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'badge-sky' },
  done: { label: '已完成', cls: 'badge-mint' },
  draft: { label: '草稿', cls: 'badge-gold' },
}

const sourceBadge: Record<string, string> = {
  arXiv: 'badge-coral',
  eprint: 'badge-sky',
}

export default function Science() {
  const [query, setQuery] = useState('')
  const [showResults, setShowResults] = useState(false)
  const [newIdea, setNewIdea] = useState('')
  const [showIdeaInput, setShowIdeaInput] = useState(false)

  function handleSearch() {
    if (query.trim()) setShowResults(true)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>科研</h1>
        <p>文献综述 · 知识图谱 · 自动科研</p>
      </div>

      <div className="page-body">
        {/* Literature Search */}
        <div className="card animate-in">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📖</span>
            <h2 className="text-base font-semibold text-ink">文献搜索</h2>
          </div>

          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="搜索学术论文 (arXiv, eprint)..."
              className="input flex-1"
            />
            <button onClick={handleSearch} className="btn btn-primary">
              搜索
            </button>
          </div>

          {showResults && (
            <div className="flex flex-col gap-2">
              {mockPapers.map((p) => (
                <div key={p.id} className="card-flat p-3 flex flex-col gap-1.5">
                  <p className="text-sm font-medium text-ink leading-snug">{p.title}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-ink-muted">{p.authors} · {p.year}</span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${sourceBadge[p.source] ?? 'badge-gold'}`}>
                      {p.source}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Research Ideas */}
        <div className="card animate-in" style={{ animationDelay: '60ms' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">💡</span>
              <h2 className="text-base font-semibold text-ink">研究灵感</h2>
            </div>
            <button
              onClick={() => setShowIdeaInput(!showIdeaInput)}
              className="btn btn-sm btn-secondary"
            >
              记录新灵感
            </button>
          </div>

          {showIdeaInput && (
            <div className="flex gap-2 mb-3">
              <input
                autoFocus
                type="text"
                value={newIdea}
                onChange={(e) => setNewIdea(e.target.value)}
                placeholder="输入研究灵感..."
                className="input flex-1"
              />
              <button
                onClick={() => { setNewIdea(''); setShowIdeaInput(false) }}
                className="btn btn-primary btn-sm"
              >
                保存
              </button>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {mockIdeas.map((idea) => {
              const cfg = statusConfig[idea.status]
              return (
                <div key={idea.id} className="card-flat p-3 flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink leading-snug">{idea.title}</p>
                    <span className="text-xs text-ink-dim mt-1 block">{idea.date}</span>
                  </div>
                  <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>
                    {cfg.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Analysis & Visualization */}
        <div className="card animate-in" style={{ animationDelay: '120ms' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📊</span>
            <h2 className="text-base font-semibold text-ink">分析可视化</h2>
          </div>

          <div className="bg-surface-2 rounded-xl p-5 text-center mb-4">
            <div className="text-3xl mb-2 opacity-60">📂</div>
            <p className="text-sm text-ink-muted">上传文献进行 AI 分析</p>
            <button className="btn btn-secondary btn-sm mt-3">选择文件</button>
          </div>

          <div className="flex flex-col gap-2">
            {[
              { icon: '🏷️', label: '关键词提取', desc: '自动识别核心概念与研究方向' },
              { icon: '🔗', label: '引用网络', desc: '构建文献间的引用关系图谱' },
              { icon: '📈', label: '趋势分析', desc: '追踪领域研究热点与发展脉络' },
            ].map((f) => (
              <div key={f.label} className="card-flat p-3 flex items-center gap-3">
                <span className="text-lg">{f.icon}</span>
                <div>
                  <p className="text-sm font-medium text-ink">{f.label}</p>
                  <p className="text-xs text-ink-muted">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
