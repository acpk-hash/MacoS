import { useState } from 'react'

type SearchMode = 'tfidf' | 'bm25' | 'semantic' | 'hybrid'

interface SearchResult {
  id: string
  title: string
  score: number
  excerpt: string
  matchHL: string
  source: string
}

interface ChatMsg {
  role: 'user' | 'ai'
  text: string
}

const MODES: { key: SearchMode; label: string }[] = [
  { key: 'tfidf', label: 'TF-IDF' },
  { key: 'bm25', label: 'BM25' },
  { key: 'semantic', label: '语义' },
  { key: 'hybrid', label: '混合' },
]

const MOCK_RESULTS: SearchResult[] = [
  {
    id: '1',
    title: '大语言模型微调技术综述',
    score: 0.96,
    excerpt: '本文系统回顾了当前主流的大语言模型微调方法，包括 LoRA、QLoRA 以及全参数微调的对比实验结果。',
    matchHL: '微调方法',
    source: '知识库 A',
  },
  {
    id: '2',
    title: 'RAG 检索增强生成架构设计',
    score: 0.89,
    excerpt: '检索增强生成（RAG）通过将外部知识检索与生成模型结合，显著降低了模型幻觉率并提升了回答质量。',
    matchHL: '检索增强生成',
    source: '知识库 B',
  },
  {
    id: '3',
    title: '向量数据库性能基准测试报告',
    score: 0.78,
    excerpt: '我们对 Milvus、Qdrant、Weaviate 和 Pinecone 进行了系统的性能基准测试，涵盖写入吞吐量与查询延迟。',
    matchHL: '向量数据库',
    source: '知识库 A',
  },
  {
    id: '4',
    title: '多模态嵌入模型对比分析',
    score: 0.65,
    excerpt: '本研究对比了 CLIP、SigLIP 和 BGE-M3 在图文跨模态检索任务中的表现差异及适用场景。',
    matchHL: '跨模态检索',
    source: '知识库 C',
  },
  {
    id: '5',
    title: '知识图谱与向量检索的融合策略',
    score: 0.52,
    excerpt: '将知识图谱的结构化关系信息与向量空间的语义表示相结合，可以实现更精准的知识问答和推理。',
    matchHL: '知识图谱',
    source: '知识库 B',
  },
]

const INDEX_STATS = {
  docCount: '12,847',
  dimension: '1,536',
  indexSize: '2.4 GB',
  lastUpdate: '2026-07-16 09:23',
}

const MOCK_CHAT: ChatMsg[] = [
  { role: 'user', text: '什么是 RAG 架构？' },
  { role: 'ai', text: '根据检索到的文档，RAG（检索增强生成）是一种将外部知识检索与生成模型结合的架构。它首先从知识库中检索相关文档片段，然后将这些片段作为上下文输入生成模型，从而显著降低幻觉率并提升回答准确性。' },
]

/* ---------- Icons ---------- */

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function EmptyIllustration() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className="opacity-30 mb-4">
      <circle cx="28" cy="28" r="18" stroke="currentColor" strokeWidth="2.5" />
      <line x1="41" y1="41" x2="56" y2="56" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="28" cy="28" r="8" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  )
}

/* ---------- Sub-components ---------- */

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color =
    pct >= 90 ? 'bg-[#10a37f]' :
    pct >= 70 ? 'bg-[#0d8de3]' :
    pct >= 50 ? 'bg-[#b7791f]' :
    'bg-[#d0342c]'

  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-mono text-ink-muted w-9 text-right">{pct}%</span>
    </div>
  )
}

function ResultCard({ result }: { result: SearchResult }) {
  const badgeColor =
    result.source === '知识库 A' ? 'badge-mint' :
    result.source === '知识库 B' ? 'badge-sky' :
    'badge-gold'

  return (
    <div className="bg-editor rounded-xl border border-line p-4 flex flex-col gap-2 animate-in">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink leading-snug flex-1">{result.title}</h3>
        <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeColor}`}>
          {result.source}
        </span>
      </div>
      <ScoreBar score={result.score} />
      <p className="text-xs text-ink-muted leading-relaxed">
        {result.excerpt.split(result.matchHL).map((part, i, arr) => (
          <span key={i}>
            {part}
            {i < arr.length - 1 && (
              <mark className="bg-[#0d8de3]/15 text-[#0d8de3] rounded px-0.5 font-medium">{result.matchHL}</mark>
            )}
          </span>
        ))}
      </p>
    </div>
  )
}

/* ---------- Main Component ---------- */

export default function VectorSearch() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('semantic')
  const [searched, setSearched] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [statsOpen, setStatsOpen] = useState(false)

  function handleSearch() {
    if (!query.trim()) return
    setSearched(true)
    setChatMessages(MOCK_CHAT)
  }

  function handleChatSend() {
    if (!chatInput.trim()) return
    setChatMessages((prev) => [
      ...prev,
      { role: 'user', text: chatInput },
      { role: 'ai', text: '正在根据检索结果生成回答...' },
    ])
    setChatInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3">
        <h1 className="text-lg font-bold text-ink">向量检索</h1>
        <p className="text-xs text-ink-muted mt-0.5">RAG 语义搜索知识库</p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-4">
        {/* Search input */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="语义搜索"
              className="w-full h-12 pl-4 pr-4 rounded-xl border border-line bg-editor text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
            />
          </div>
          <button
            onClick={handleSearch}
            className="shrink-0 w-12 h-12 rounded-xl bg-primary text-white flex items-center justify-center active:opacity-80 transition-opacity"
          >
            <SearchIcon />
          </button>
        </div>

        {/* Mode pills */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`shrink-0 px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                mode === m.key
                  ? 'bg-primary text-white'
                  : 'bg-surface-2 text-ink-muted active:bg-line'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {!searched ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-16 text-ink-dim">
            <EmptyIllustration />
            <p className="text-sm font-medium">输入关键词开始语义搜索</p>
            <p className="text-xs text-ink-faint mt-1">支持自然语言查询，AI 将从知识库中检索相关内容</p>
          </div>
        ) : (
          <>
            {/* Results */}
            <section>
              <div className="flex items-center justify-between mb-2 px-1">
                <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">检索结果</p>
                <span className="text-[10px] text-ink-faint font-mono">{MOCK_RESULTS.length} 条匹配</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {MOCK_RESULTS.map((r) => (
                  <ResultCard key={r.id} result={r} />
                ))}
              </div>
            </section>

            {/* RAG Chat panel */}
            <section>
              <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2 px-1">基于检索结果对话</p>
              <div className="bg-editor rounded-xl border border-line overflow-hidden">
                {/* Chat messages */}
                <div className="max-h-56 overflow-y-auto p-3 flex flex-col gap-2.5">
                  {chatMessages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-primary text-white rounded-br-sm'
                            : 'bg-surface-2 text-ink rounded-bl-sm'
                        }`}
                      >
                        {msg.role === 'ai' && (
                          <span className="block text-[10px] font-medium text-done mb-1">AI (基于 RAG)</span>
                        )}
                        {msg.text}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Chat input */}
                <div className="border-t border-line-soft p-2 flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleChatSend()}
                    placeholder="基于检索上下文提问..."
                    className="flex-1 h-9 px-3 rounded-lg border border-line bg-bg text-xs text-ink placeholder-ink-faint focus:outline-none focus:border-primary transition"
                  />
                  <button
                    onClick={handleChatSend}
                    className="shrink-0 w-9 h-9 rounded-lg bg-primary text-white flex items-center justify-center active:opacity-80 transition-opacity"
                  >
                    <SendIcon />
                  </button>
                </div>
              </div>
            </section>

            {/* Index stats */}
            <section>
              <button
                onClick={() => setStatsOpen(!statsOpen)}
                className="w-full flex items-center justify-between px-1 mb-2"
              >
                <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">索引统计</p>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`text-ink-dim transition-transform ${statsOpen ? 'rotate-180' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {statsOpen && (
                <div className="bg-editor rounded-xl border border-line divide-y divide-line-soft animate-in">
                  {([
                    ['文档数', INDEX_STATS.docCount],
                    ['向量维度', INDEX_STATS.dimension],
                    ['索引大小', INDEX_STATS.indexSize],
                    ['最后更新', INDEX_STATS.lastUpdate],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="px-4 py-3 flex items-center justify-between">
                      <span className="text-xs text-ink-muted">{label}</span>
                      <span className="text-sm font-mono text-ink">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
