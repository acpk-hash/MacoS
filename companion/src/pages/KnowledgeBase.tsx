import { useState } from 'react'

interface Document {
  id: string
  filename: string
  size: string
  date: string
  type: 'pdf' | 'txt' | 'md' | 'docx'
  tags: string[]
}

const TYPE_ICONS: Record<Document['type'], string> = {
  pdf: '\u{1F4D5}',
  txt: '\u{1F4C4}',
  md: '\u{1F4DD}',
  docx: '\u{1F4D8}',
}

const MOCK_DOCS: Document[] = [
  { id: '1', filename: '产品需求文档 v2.pdf', size: '2.4 MB', date: '2026-07-15', type: 'pdf', tags: ['产品', '需求'] },
  { id: '2', filename: '技术架构设计.md', size: '156 KB', date: '2026-07-14', type: 'md', tags: ['技术', '架构'] },
  { id: '3', filename: '用户调研报告.docx', size: '1.8 MB', date: '2026-07-12', type: 'docx', tags: ['调研', '用户'] },
  { id: '4', filename: 'API 接口规范.md', size: '89 KB', date: '2026-07-10', type: 'md', tags: ['技术', 'API'] },
  { id: '5', filename: '竞品分析.pdf', size: '3.1 MB', date: '2026-07-08', type: 'pdf', tags: ['分析', '竞品'] },
  { id: '6', filename: '部署指南.txt', size: '42 KB', date: '2026-07-05', type: 'txt', tags: ['运维', '部署'] },
  { id: '7', filename: '数据模型说明.md', size: '67 KB', date: '2026-07-03', type: 'md', tags: ['技术', '数据'] },
]

const ALL_TAGS = Array.from(new Set(MOCK_DOCS.flatMap((d) => d.tags)))

export default function KnowledgeBase() {
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const filtered = MOCK_DOCS.filter((doc) => {
    const matchSearch = !search || doc.filename.toLowerCase().includes(search.toLowerCase())
    const matchTag = !activeTag || doc.tags.includes(activeTag)
    return matchSearch && matchTag
  })

  const totalSize = '7.6 MB'
  const lastUpdated = '2026-07-15'

  return (
    <div className="page">
      <div className="page-header">
        <h1>{'知识库'}</h1>
        <p>{'管理文档与知识资产'}</p>
      </div>
      <div className="page-body flex flex-col gap-3">
        {/* Stats bar */}
        <div className="card-flat">
          <div className="flex items-center justify-between">
            <div className="text-center flex-1">
              <p className="text-lg font-bold text-ink">{MOCK_DOCS.length}</p>
              <p className="text-[11px] text-ink-dim">{'文档总数'}</p>
            </div>
            <div className="w-px h-8 bg-line-soft" />
            <div className="text-center flex-1">
              <p className="text-lg font-bold text-ink">{totalSize}</p>
              <p className="text-[11px] text-ink-dim">{'总大小'}</p>
            </div>
            <div className="w-px h-8 bg-line-soft" />
            <div className="text-center flex-1">
              <p className="text-lg font-bold text-ink">{lastUpdated}</p>
              <p className="text-[11px] text-ink-dim">{'最近更新'}</p>
            </div>
          </div>
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索文档…"
          className="input"
        />

        {/* Tag filter pills */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
          <button
            onClick={() => setActiveTag(null)}
            className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              activeTag === null ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted'
            }`}
          >
            {'全部'}
          </button>
          {ALL_TAGS.map((tag) => (
            <button
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                activeTag === tag ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>

        {/* Upload button */}
        <button className="btn btn-secondary btn-block">
          {'+ 上传文档'}
        </button>
        <p className="text-[11px] text-ink-faint text-center -mt-1">{'支持 PDF、TXT、MD、DOCX 格式'}</p>

        {/* Document list */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint animate-in">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p className="text-sm">{'未找到匹配的文档'}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((doc) => (
              <div key={doc.id} className="card animate-in">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-lg shrink-0">
                    {TYPE_ICONS[doc.type]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{doc.filename}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-ink-dim">{doc.size}</span>
                      <span className="text-[11px] text-ink-dim">{doc.date}</span>
                    </div>
                    <div className="flex gap-1.5 mt-1.5">
                      {doc.tags.map((tag) => (
                        <span key={tag} className="badge badge-sky">{tag}</span>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs text-ink-faint uppercase font-mono shrink-0">{doc.type}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
