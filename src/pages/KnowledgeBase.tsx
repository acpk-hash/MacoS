import { useEffect, useMemo, useCallback, useState, useRef } from 'react'
import type { InputHTMLAttributes } from 'react'
import { useKnowledgeStore } from '../stores/knowledgeStore'
import type { KBDocument, KBTab, DocFormat, DocSortBy, GraphNode, GraphEdge } from '../stores/knowledgeStore'
import { MarkdownLite } from '../components/ui/MarkdownLite'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const FORMAT_LABELS: Record<DocFormat, string> = {
  md: 'Markdown',
  docx: 'Word',
  html: 'HTML',
  pdf: 'PDF',
  txt: '文本',
}

const SOURCE_LABELS: Record<string, string> = {
  office: '办公',
  science: '科研',
  agent: 'Agent',
  upload: '上传',
  import: '导入',
}

const TAB_ITEMS: { key: KBTab; label: string }[] = [
  { key: 'docs', label: '文档库' },
  { key: 'graph', label: '知识图谱' },
  { key: 'io', label: '导入导出' },
]

const SORT_OPTS: { key: DocSortBy; label: string }[] = [
  { key: 'time', label: '时间' },
  { key: 'title', label: '标题' },
  { key: 'format', label: '格式' },
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DocRow({
  doc,
  onSelect,
  onDelete,
}: {
  doc: KBDocument
  onSelect: (d: KBDocument) => void
  onDelete: (id: string) => void
}) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-2 cursor-pointer group transition-colors"
      onClick={() => onSelect(doc)}
    >
      <span className="w-8 h-8 rounded bg-primary-tint text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">
        {doc.format.toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-ink truncate">{doc.title}</div>
        <div className="text-xs text-ink-dim flex items-center gap-2 mt-0.5">
          <span>{SOURCE_LABELS[doc.source] ?? doc.source}</span>
          <span>{new Date(doc.createdAt).toLocaleDateString()}</span>
          {doc.tags.map((t) => (
            <span key={t} className="px-1.5 py-0 rounded bg-surface-2 text-ink-muted">
              {t}
            </span>
          ))}
        </div>
      </div>
      <button
        className="text-xs text-ink-faint hover:text-failed opacity-0 group-hover:opacity-100 transition-opacity"
        title="删除"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(doc.id)
        }}
      >
        删除
      </button>
    </div>
  )
}

function DocPreview({ doc, onClose }: { doc: KBDocument; onClose: () => void }) {
  return (
    <div className="flex-1 flex flex-col border-l border-line bg-editor min-w-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface">
        <h3 className="text-sm font-semibold text-ink truncate">{doc.title}</h3>
        <button className="text-xs text-ink-dim hover:text-ink" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {doc.preview ? (
          <MarkdownLite text={doc.preview} />
        ) : doc.format === 'html' ? (
          <iframe
            title={doc.title}
            srcDoc="<p style='color:#888'>HTML 预览暂不可用</p>"
            className="w-full h-full border-0"
          />
        ) : (
          <div className="text-sm text-ink-muted">
            该文档类型（{FORMAT_LABELS[doc.format]}）暂不支持内联预览。
            {doc.path && <div className="mt-2 text-xs text-ink-faint break-all">路径: {doc.path}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Knowledge Graph (force-directed SVG)
// ---------------------------------------------------------------------------

function buildGraph(docs: KBDocument[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = docs.map((d, i) => ({
    id: d.id,
    label: d.title.length > 20 ? d.title.slice(0, 18) + '...' : d.title,
    x: 300 + Math.cos((i / docs.length) * Math.PI * 2) * 200 + (Math.random() - 0.5) * 40,
    y: 250 + Math.sin((i / docs.length) * Math.PI * 2) * 150 + (Math.random() - 0.5) * 40,
    vx: 0,
    vy: 0,
    tags: d.tags,
  }))

  const edges: GraphEdge[] = []
  const byTitle = new Map(docs.map((d) => [d.title.toLowerCase(), d]))
  const seen = new Set<string>()
  const addEdge = (source: string, target: string, relation: string) => {
    if (source === target) return
    const key = source < target ? source + '::' + target + '::' + relation : target + '::' + source + '::' + relation
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source, target, relation })
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[i].tags.filter((t) => nodes[j].tags.includes(t))
      if (shared.length > 0) addEdge(nodes[i].id, nodes[j].id, shared.slice(0, 3).join(', '))
    }
  }
  for (const doc of docs) {
    for (const link of doc.links ?? []) {
      const target = byTitle.get(link.toLowerCase())
      if (target) addEdge(doc.id, target.id, 'link')
    }
  }
  return { nodes, edges }
}

function KnowledgeGraph({ docs }: { docs: KBDocument[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })

  useEffect(() => {
    if (docs.length === 0) return
    const g = buildGraph(docs)

    for (let iter = 0; iter < 50; iter++) {
      const ns = g.nodes
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = ns[j].x - ns[i].x
          const dy = ns[j].y - ns[i].y
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
          const force = 2000 / (dist * dist)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          ns[i].vx -= fx; ns[i].vy -= fy
          ns[j].vx += fx; ns[j].vy += fy
        }
      }
      for (const e of g.edges) {
        const s = ns.find((n) => n.id === e.source)
        const t = ns.find((n) => n.id === e.target)
        if (!s || !t) continue
        const dx = t.x - s.x; const dy = t.y - s.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const force = dist * 0.005
        s.vx += dx * force; s.vy += dy * force
        t.vx -= dx * force; t.vy -= dy * force
      }
      for (const n of ns) {
        n.vx += (400 - n.x) * 0.001; n.vy += (250 - n.y) * 0.001
        n.x += n.vx * 0.3; n.y += n.vy * 0.3
        n.vx *= 0.7; n.vy *= 0.7
      }
    }
    setGraphData(g)
  }, [docs])

  if (docs.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-ink-muted text-sm">暂无文档，无法生成知识图谱。</div>
  }

  const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]))

  return (
    <div className="flex-1 overflow-hidden bg-editor rounded-lg border border-line">
      <svg ref={svgRef} viewBox="0 0 800 500" className="w-full h-full" style={{ minHeight: 400 }}>
        {graphData.edges.map((e, i) => {
          const s = nodeMap.get(e.source); const t = nodeMap.get(e.target)
          if (!s || !t) return null
          return (
            <g key={i}>
              <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="var(--color-line, #444)" strokeWidth={1} opacity={0.5} />
              <text x={(s.x + t.x) / 2} y={(s.y + t.y) / 2 - 4} textAnchor="middle" fontSize={8} fill="var(--color-ink-faint, #888)">{e.relation}</text>
            </g>
          )
        })}
        {graphData.nodes.map((n) => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={18} fill="var(--color-primary-tint, #3b3b5c)" stroke="var(--color-primary, #6366f1)" strokeWidth={1.5} />
            <text x={n.x} y={n.y + 28} textAnchor="middle" fontSize={10} fill="var(--color-ink-muted, #aaa)">{n.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import/Export Panel
// ---------------------------------------------------------------------------

function IOPanel() {
  const { importObsidianVault, importNotionZip, exportMarkdownFolder, documents } = useKnowledgeStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const [importMode, setImportMode] = useState<'obsidian' | 'notion' | null>(null)

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      const entries: { name: string; content: string }[] = []
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        if (f.name.endsWith('.md') || f.name.endsWith('.html') || f.name.endsWith('.txt')) {
          const content = await f.text()
          entries.push({ name: rel, content })
        }
      }
      if (importMode === 'obsidian') importObsidianVault(entries)
      else if (importMode === 'notion') importNotionZip(entries)
      setImportMode(null)
      if (fileRef.current) fileRef.current.value = ''
      if (dirRef.current) dirRef.current.value = ''
    },
    [importMode, importObsidianVault, importNotionZip],
  )

  return (
    <div className="flex-1 p-4 space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-ink mb-3">导入</h3>
        <div className="flex gap-3">
          <button className="px-4 py-2 rounded-lg bg-surface-2 hover:bg-primary-tint text-sm text-ink transition-colors" onClick={() => { setImportMode('obsidian'); dirRef.current?.click() }}>
            导入 Obsidian Vault
          </button>
          <button className="px-4 py-2 rounded-lg bg-surface-2 hover:bg-primary-tint text-sm text-ink transition-colors" onClick={() => { setImportMode('notion'); fileRef.current?.click() }}>
            导入 Notion 导出
          </button>
        </div>
        {/* Separate inputs: dirRef for Obsidian (folder), fileRef for Notion (files) */}
        <input
          ref={dirRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          {...{ webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".md,.html,.txt"
          className="hidden"
          onChange={handleFileChange}
        />
        <p className="text-xs text-ink-faint mt-2">Obsidian: 选择 vault 文件夹，保留相对路径并提取 #tag / [[双链]] 生成图谱。Notion: 选择导出的 .md/.html 文件。</p>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-ink mb-3">导出</h3>
        <button className="px-4 py-2 rounded-lg bg-surface-2 hover:bg-primary-tint text-sm text-ink transition-colors disabled:opacity-40" disabled={documents.length === 0} onClick={exportMarkdownFolder}>
          导出为 Markdown 文件
        </button>
        <p className="text-xs text-ink-faint mt-2">将所有有预览内容的文档逐一下载为 .md 文件。</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function KnowledgeBase() {
  const store = useKnowledgeStore()
  const [selectedDoc, setSelectedDoc] = useState<KBDocument | null>(null)

  useEffect(() => {
    store._hydrate()
    store.collectFromStores()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const uploadRef = useRef<HTMLInputElement>(null)
  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files) return
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const ext = f.name.split('.').pop()?.toLowerCase() ?? 'txt'
        const format: DocFormat = (['md', 'docx', 'html', 'pdf', 'txt'].includes(ext) ? ext : 'txt') as DocFormat
        let preview: string | undefined
        if (format === 'md' || format === 'txt' || format === 'html') {
          preview = await f.text()
        }
        store.addDocument({
          id: uid(),
          title: f.name.replace(/\.[^.]+$/, ''),
          source: 'upload',
          format,
          path: URL.createObjectURL(f),
          tags: ['upload'],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          preview,
          size: f.size,
        })
      }
      if (uploadRef.current) uploadRef.current.value = ''
    },
    [store],
  )

  const filtered = useMemo(() => {
    let docs = store.documents
    if (store.filterTag) docs = docs.filter((d) => d.tags.includes(store.filterTag!))
    if (store.filterFormat) docs = docs.filter((d) => d.format === store.filterFormat)
    if (store.searchQuery) {
      const q = store.searchQuery.toLowerCase()
      docs = docs.filter((d) => d.title.toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q)))
    }
    if (store.sortBy === 'time') docs = [...docs].sort((a, b) => b.createdAt - a.createdAt)
    else if (store.sortBy === 'title') docs = [...docs].sort((a, b) => a.title.localeCompare(b.title))
    else docs = [...docs].sort((a, b) => a.format.localeCompare(b.format))
    return docs
  }, [store.documents, store.filterTag, store.filterFormat, store.searchQuery, store.sortBy])

  const allTags = useMemo(() => {
    const s = new Set<string>()
    store.documents.forEach((d) => d.tags.forEach((t) => s.add(t)))
    return Array.from(s).sort()
  }, [store.documents])

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-4 px-4 py-2 border-b border-line bg-surface flex-shrink-0">
        <h2 className="text-sm font-bold text-ink">知识库</h2>
        <nav className="flex gap-1 ml-2">
          {TAB_ITEMS.map((t) => (
            <button
              key={t.key}
              className={[
                'px-3 py-1 rounded text-xs transition-colors',
                store.tab === t.key ? 'bg-primary-tint text-primary font-semibold' : 'text-ink-dim hover:bg-surface-2 hover:text-ink-muted',
              ].join(' ')}
              onClick={() => store.setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="flex-1" />
        <span className="text-xs text-ink-faint">{store.documents.length} 篇文档</span>
      </header>

      {store.tab === 'docs' && (
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col w-80 border-r border-line flex-shrink-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-surface">
              <input type="text" placeholder="搜索文档..." value={store.searchQuery} onChange={(e) => store.setSearchQuery(e.target.value)} className="flex-1 px-2 py-1 text-xs bg-editor border border-line rounded text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary" />
              <button className="px-2 py-1 text-xs rounded bg-primary text-white hover:bg-primary-hover transition-colors" onClick={() => uploadRef.current?.click()}>上传</button>
              <input ref={uploadRef} type="file" multiple accept=".md,.txt,.html,.pdf,.docx" className="hidden" onChange={handleUpload} />
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line text-xs">
              <span className="text-ink-faint">排序:</span>
              {SORT_OPTS.map((o) => (
                <button key={o.key} className={store.sortBy === o.key ? 'text-primary font-semibold' : 'text-ink-dim hover:text-ink'} onClick={() => store.setSortBy(o.key)}>{o.label}</button>
              ))}
              {allTags.length > 0 && (
                <>
                  <span className="text-line mx-1">|</span>
                  <select className="bg-editor border border-line rounded px-1 py-0.5 text-xs text-ink" value={store.filterTag ?? ''} onChange={(e) => store.setFilterTag(e.target.value || null)}>
                    <option value="">全部标签</option>
                    {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {filtered.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-sm text-ink-muted">暂无文档</div>
              ) : (
                filtered.map((d) => <DocRow key={d.id} doc={d} onSelect={setSelectedDoc} onDelete={(id) => { store.removeDocument(id); if (selectedDoc?.id === id) setSelectedDoc(null) }} />)
              )}
            </div>
          </div>
          {selectedDoc ? (
            <DocPreview doc={selectedDoc} onClose={() => setSelectedDoc(null)} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-ink-muted">选择文档以预览</div>
          )}
        </div>
      )}

      {store.tab === 'graph' && (
        <div className="flex flex-1 min-h-0 p-4">
          <KnowledgeGraph docs={store.documents} />
        </div>
      )}

      {store.tab === 'io' && <IOPanel />}
    </div>
  )
}