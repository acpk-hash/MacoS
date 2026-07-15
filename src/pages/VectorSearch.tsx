// VectorSearch.tsx — RAG 向量检索页面
// 纯前端 TF-IDF + BM25 混合搜索，索引存 localStorage。
// 右侧可切换 RAG 对话面板，自动注入 top-K 文档作为上下文。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Paper } from '../stores/kbStore'
import { useKbStore } from '../stores/kbStore'

// ── Tauri helpers (local, same pattern as every page) ───────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── StudioEvent (streaming chat) ────────────────────────────────────────────

interface StudioEvent {
  type: string
  session_id?: string
  message_id?: string
  text?: string
  status?: string
  message?: string
  input_tokens?: number
  output_tokens?: number
}

// ── Constants ───────────────────────────────────────────────────────────────

const INDEX_STORAGE_KEY = 'iris-vector-index'
const CARD = 'rounded-card border border-line bg-surface p-3'
const INPUT =
  'w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60'
const BTN_PRIMARY =
  'rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors disabled:opacity-40'
const BTN_SECONDARY =
  'rounded-input border border-line bg-surface px-3 py-1.5 text-[12px] text-ink hover:bg-surface-2 transition-colors disabled:opacity-40'
const CHIP_BASE =
  'text-[10.5px] px-2 py-0.5 rounded-chip border transition-colors cursor-pointer select-none'
const CHIP_ACTIVE =
  'bg-primary-tint border-primary/60 text-primary font-medium'
const CHIP_INACTIVE =
  'bg-surface-2 border-line text-ink-muted hover:text-ink'

// ── Chinese + English stopwords ─────────────────────────────────────────────

const STOPWORDS = new Set([
  // English
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can',
  'could','this','that','these','those','it','its','i','me','my','we','our',
  'you','your','he','him','his','she','her','they','them','their','what',
  'which','who','whom','not','no','nor','if','then','than','so','as','up',
  'out','about','into','over','after','before','between','under','above',
  'very','just','also','more','most','much','many','some','any','all','each',
  'every','both','few','other','such','only','own','same','too','s','t','re',
  // Chinese particles / function words
  '的','了','和','是','在','有','不','人','这','中','大','为','上','个','国',
  '我','以','要','他','时','来','用','们','生','到','作','地','于','出','会',
  '可','也','你','对','与','就','等','被','从','而','那','但','去','又','能',
  '好','都','然','没','日','手','把','无','已','及','其','所',
])

// ── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  // Split on whitespace and punctuation, keep CJK characters as individual tokens
  const raw = lower.match(/[一-鿿]|[a-z0-9]+/g) || []
  return raw.filter((t) => t.length > 1 || /[一-鿿]/.test(t))
    .filter((t) => !STOPWORDS.has(t))
}

// ── Index types ─────────────────────────────────────────────────────────────

interface DocEntry {
  id: string
  title: string
  content: string       // abstract + authors + title joined
  filePath: string | null
  tags: string[]
  categoryId: string | null
  starred: boolean
  addedAt: number | null
  tokens: string[]
  tf: Record<string, number>     // term → TF value
  length: number                 // token count
}

interface Index {
  docs: DocEntry[]
  df: Record<string, number>     // term → document frequency
  avgDl: number                  // average document length
  totalDocs: number
  builtAt: number                // timestamp
}

interface SearchResult {
  doc: DocEntry
  score: number
  bm25Score: number
  semanticScore: number
  matchedTerms: string[]
}

// ── Build Index ─────────────────────────────────────────────────────────────

function buildIndex(
  docs: { id: string; title: string; content: string; filePath: string | null; tags: string[]; categoryId: string | null; starred: boolean; addedAt: number | null }[],
): Index {
  const df: Record<string, number> = {}
  let totalLength = 0

  const entries: DocEntry[] = docs.map((d) => {
    const tokens = tokenize(d.title + ' ' + d.content)
    const tf: Record<string, number> = {}
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1
    }
    totalLength += tokens.length
    // Count DF — each term counted once per doc
    const seen = new Set<string>()
    for (const t of tokens) {
      if (!seen.has(t)) {
        df[t] = (df[t] || 0) + 1
        seen.add(t)
      }
    }
    return {
      id: d.id,
      title: d.title,
      content: d.content,
      filePath: d.filePath,
      tags: d.tags,
      categoryId: d.categoryId,
      starred: d.starred,
      addedAt: d.addedAt,
      tokens,
      tf,
      length: tokens.length,
    }
  })

  return {
    docs: entries,
    df,
    avgDl: entries.length > 0 ? totalLength / entries.length : 0,
    totalDocs: entries.length,
    builtAt: Date.now(),
  }
}

// ── BM25 search ─────────────────────────────────────────────────────────────

const K1 = 1.5
const B = 0.75

function searchBM25(query: string, index: Index, k: number): SearchResult[] {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []

  const results: SearchResult[] = []
  for (const doc of index.docs) {
    let score = 0
    const matched: string[] = []
    for (const qt of qTokens) {
      const tf = doc.tf[qt] || 0
      if (tf === 0) continue
      matched.push(qt)
      const docFreq = index.df[qt] || 0
      const idf = Math.log(
        (index.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1,
      )
      const tfNorm =
        (tf * (K1 + 1)) /
        (tf + K1 * (1 - B + B * (doc.length / index.avgDl)))
      score += idf * tfNorm
    }
    if (score > 0) {
      results.push({ doc, score, bm25Score: score, semanticScore: 0, matchedTerms: matched })
    }
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, k)
}

// ── Semantic search (cosine similarity on TF-IDF vectors) ───────────────────

function computeTfIdfVector(
  tf: Record<string, number>,
  docLength: number,
  df: Record<string, number>,
  totalDocs: number,
): Record<string, number> {
  const vec: Record<string, number> = {}
  for (const term of Object.keys(tf)) {
    const termTf = tf[term] / (docLength || 1)
    const idf = Math.log((totalDocs + 1) / ((df[term] || 0) + 1)) + 1
    vec[term] = termTf * idf
  }
  return vec
}

function cosineSim(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let dot = 0
  let magA = 0
  let magB = 0
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of allKeys) {
    const va = a[k] || 0
    const vb = b[k] || 0
    dot += va * vb
    magA += va * va
    magB += vb * vb
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

function searchSemantic(
  query: string,
  index: Index,
  k: number,
): SearchResult[] {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []

  const qTf: Record<string, number> = {}
  for (const t of qTokens) qTf[t] = (qTf[t] || 0) + 1
  const qVec = computeTfIdfVector(qTf, qTokens.length, index.df, index.totalDocs)

  const results: SearchResult[] = []
  for (const doc of index.docs) {
    const dVec = computeTfIdfVector(doc.tf, doc.length, index.df, index.totalDocs)
    const sim = cosineSim(qVec, dVec)
    if (sim > 0) {
      const matched = qTokens.filter((t) => (doc.tf[t] || 0) > 0)
      results.push({ doc, score: sim, bm25Score: 0, semanticScore: sim, matchedTerms: matched })
    }
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, k)
}

// ── Hybrid search ───────────────────────────────────────────────────────────

function searchHybrid(
  query: string,
  index: Index,
  k: number,
  alpha: number, // 0 = pure keyword, 1 = pure semantic
): SearchResult[] {
  const bm25 = searchBM25(query, index, index.totalDocs)
  const sem = searchSemantic(query, index, index.totalDocs)

  // Normalize scores to 0-1 range
  const maxBm25 = bm25.length > 0 ? bm25[0].score : 1
  const maxSem = sem.length > 0 ? sem[0].score : 1

  const scoreMap = new Map<string, SearchResult>()

  for (const r of bm25) {
    const normBm25 = r.score / maxBm25
    scoreMap.set(r.doc.id, {
      ...r,
      bm25Score: normBm25,
      semanticScore: 0,
      score: (1 - alpha) * normBm25,
    })
  }

  for (const r of sem) {
    const normSem = r.score / maxSem
    const existing = scoreMap.get(r.doc.id)
    if (existing) {
      existing.semanticScore = normSem
      existing.score += alpha * normSem
      // Merge matched terms
      const merged = new Set([...existing.matchedTerms, ...r.matchedTerms])
      existing.matchedTerms = [...merged]
    } else {
      scoreMap.set(r.doc.id, {
        ...r,
        bm25Score: 0,
        semanticScore: normSem,
        score: alpha * normSem,
      })
    }
  }

  const results = [...scoreMap.values()]
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, k)
}

// ── Excerpt highlighting ────────────────────────────────────────────────────

function highlightExcerpt(
  text: string,
  matchedTerms: string[],
  maxLen = 280,
): { before: string; match: string; after: string } {
  if (!text || matchedTerms.length === 0) {
    return { before: text.slice(0, maxLen), match: '', after: '' }
  }
  const lower = text.toLowerCase()
  let bestIdx = -1
  let bestTerm = ''
  for (const term of matchedTerms) {
    const idx = lower.indexOf(term)
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx
      bestTerm = term
    }
  }
  if (bestIdx < 0) {
    return { before: text.slice(0, maxLen), match: '', after: '' }
  }
  const start = Math.max(0, bestIdx - 60)
  const end = Math.min(text.length, bestIdx + bestTerm.length + 160)
  const before = (start > 0 ? '…' : '') + text.slice(start, bestIdx)
  const match = text.slice(bestIdx, bestIdx + bestTerm.length)
  const after = text.slice(bestIdx + bestTerm.length, end) + (end < text.length ? '…' : '')
  return { before, match, after }
}

// ── Score display (0-100) ───────────────────────────────────────────────────

function scoreToPercent(score: number, max: number): number {
  if (max <= 0) return 0
  return Math.round(Math.min(100, (score / max) * 100))
}

// ── Search mode type ────────────────────────────────────────────────────────

type SearchMode = 'keyword' | 'semantic' | 'hybrid'

// ── Chat message ────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  citations?: string[]  // paper titles used as context
}

// ═══════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════

export default function VectorSearch() {
  // ── KB store ──────────────────────────────────────────────────────────
  const papers = useKbStore((s) => s.papers)
  const categories = useKbStore((s) => s.categories)
  const tags = useKbStore((s) => s.tags)
  const loadPapers = useKbStore((s) => s.loadPapers)
  const loadCategories = useKbStore((s) => s.loadCategories)
  const loadTags = useKbStore((s) => s.loadTags)

  // ── Local state ───────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [alpha, setAlpha] = useState(0.5) // hybrid weight
  const [topK] = useState(20)

  // Filters
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [filterStarred, setFilterStarred] = useState(false)
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  // Index
  const [index, setIndex] = useState<Index | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState(0)

  // Results
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)

  // RAG Chat
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatStreaming, setChatStreaming] = useState(false)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatListenerRef = useRef<(() => void) | null>(null)

  // ── Load KB data on mount ─────────────────────────────────────────────
  useEffect(() => {
    loadPapers()
    loadCategories()
    loadTags()
  }, [loadPapers, loadCategories, loadTags])

  // ── Restore index from localStorage ───────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(INDEX_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Index
        if (parsed && parsed.docs && parsed.df) {
          setIndex(parsed)
        }
      }
    } catch {
      // ignore corrupt storage
    }
  }, [])

  // ── Build / rebuild index ─────────────────────────────────────────────
  const rebuildIndex = useCallback(async () => {
    if (!isTauri) return
    setIndexing(true)
    setIndexProgress(0)

    try {
      // Fetch all papers with full detail (need abstract)
      const summaries = papers.length > 0 ? papers : await (async () => {
        await loadPapers()
        return useKbStore.getState().papers
      })()

      const docs: { id: string; title: string; content: string; filePath: string | null; tags: string[]; categoryId: string | null; starred: boolean; addedAt: number | null }[] = []
      const total = summaries.length

      for (let i = 0; i < total; i++) {
        const s = summaries[i]
        try {
          const full = await tauriInvoke<Paper | null>('kb_get_paper', { id: s.id })
          if (full) {
            const content = [
              full.title || '',
              full.authors || '',
              full.abstract || '',
              full.venue || '',
              full.notes || '',
            ].join(' ')
            docs.push({
              id: full.id,
              title: full.title || full.orig_filename || full.id,
              content,
              filePath: full.file_path,
              tags: full.tags.map((t) => t.name),
              categoryId: full.category_id,
              starred: full.starred === 1,
              addedAt: full.added_at,
            })
          }
        } catch {
          // skip individual failures
        }
        setIndexProgress(Math.round(((i + 1) / total) * 100))
      }

      const newIndex = buildIndex(docs)
      setIndex(newIndex)

      // Persist to localStorage (strip tokens arrays to save space)
      try {
        const toStore: Index = {
          ...newIndex,
          docs: newIndex.docs.map((d) => ({ ...d, tokens: [] })),
        }
        localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(toStore))
      } catch {
        // localStorage quota exceeded — ignore
      }
    } finally {
      setIndexing(false)
      setIndexProgress(100)
    }
  }, [papers, loadPapers])

  // ── Auto-build index if none exists and papers are loaded ─────────────
  useEffect(() => {
    if (!index && papers.length > 0 && !indexing) {
      rebuildIndex()
    }
  }, [papers, index, indexing, rebuildIndex])

  // ── Execute search ────────────────────────────────────────────────────
  const doSearch = useCallback(() => {
    if (!index || !query.trim()) {
      setResults([])
      setSearched(false)
      return
    }
    setSearched(true)
    let raw: SearchResult[]
    switch (mode) {
      case 'keyword':
        raw = searchBM25(query, index, topK)
        break
      case 'semantic':
        raw = searchSemantic(query, index, topK)
        break
      case 'hybrid':
      default:
        raw = searchHybrid(query, index, topK, alpha)
        break
    }

    // Apply filters
    raw = raw.filter((r) => {
      if (filterCategory && r.doc.categoryId !== filterCategory) return false
      if (filterTag && !r.doc.tags.includes(filterTag)) return false
      if (filterStarred && !r.doc.starred) return false
      if (filterDateFrom) {
        const from = new Date(filterDateFrom).getTime() / 1000
        if (r.doc.addedAt && r.doc.addedAt < from) return false
      }
      if (filterDateTo) {
        const to = new Date(filterDateTo).getTime() / 1000
        if (r.doc.addedAt && r.doc.addedAt > to) return false
      }
      return true
    })

    setResults(raw)
  }, [index, query, mode, topK, alpha, filterCategory, filterTag, filterStarred, filterDateFrom, filterDateTo])

  // ── Keyboard shortcut ─────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        doSearch()
      }
    },
    [doSearch],
  )

  // ── Chat: setup studio-event listener ─────────────────────────────────
  useEffect(() => {
    if (!isTauri) return
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<StudioEvent>('studio-event', (evt) => {
          if (cancelled) return
          const p = evt.payload
          // Only handle our session
          setChatSessionId((sid) => {
            if (!sid || p.session_id !== sid) return sid
            switch (p.type) {
              case 'delta':
                if (p.text) {
                  setChatMessages((msgs) => {
                    const last = msgs[msgs.length - 1]
                    if (last && last.role === 'assistant') {
                      return [
                        ...msgs.slice(0, -1),
                        { ...last, text: last.text + p.text },
                      ]
                    }
                    return [...msgs, { role: 'assistant', text: p.text! }]
                  })
                }
                break
              case 'done':
                setChatStreaming(false)
                break
              case 'error':
                setChatStreaming(false)
                setChatMessages((msgs) => [
                  ...msgs,
                  { role: 'assistant', text: '出错: ' + (p.message || '未知错误') },
                ])
                break
            }
            return sid
          })
        })
        chatListenerRef.current = unlisten
      } catch {
        // non-Tauri
      }
    })()
    return () => {
      cancelled = true
      chatListenerRef.current?.()
      chatListenerRef.current = null
    }
  }, [])

  // ── Chat: auto-scroll ─────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  // ── Chat: send message with RAG context ───────────────────────────────
  const sendChatMessage = useCallback(
    async (userText: string, contextOverride?: { title: string; content: string }[]) => {
      if (!isTauri || chatStreaming || !userText.trim()) return
      setChatStreaming(true)

      // Get RAG context: top-K results from current search, or do a fresh search
      let contextDocs: { title: string; content: string }[] = []
      if (contextOverride) {
        contextDocs = contextOverride
      } else if (index) {
        const ragResults = searchHybrid(userText, index, 5, 0.5)
        contextDocs = ragResults.map((r) => ({
          title: r.doc.title,
          content: r.doc.content,
        }))
      }

      const citations = contextDocs.map((d) => d.title)

      // Build the user message with injected context
      let userContent = userText
      if (contextDocs.length > 0) {
        const contextBlock = contextDocs
          .map(
            (d, i) =>
              `[文档${i + 1}] ${d.title}\n${d.content.slice(0, 800)}`,
          )
          .join('\n\n---\n\n')
        userContent = `以下是从知识库中检索到的相关文档，请基于这些文档回答用户的问题。如果文档中没有足够信息，请说明。\n\n${contextBlock}\n\n---\n\n用户问题: ${userText}`
      }

      setChatMessages((msgs) => [
        ...msgs,
        { role: 'user', text: userText, citations },
      ])

      try {
        // Create session if needed
        let sid = chatSessionId
        if (!sid) {
          const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
            title: '[RAG] 知识库问答',
            model: 'gpt-4o-mini',
          })
          sid = row.id
          setChatSessionId(sid)
        }

        // Push an empty assistant message that streaming will fill
        setChatMessages((msgs) => [...msgs, { role: 'assistant', text: '' }])

        await tauriInvoke<string>('chat_send', {
          sessionId: sid,
          userContent,
          attachments: [],
          model: 'gpt-4o-mini',
          providerId: null,
        })
      } catch (e) {
        setChatStreaming(false)
        setChatMessages((msgs) => [
          ...msgs,
          { role: 'assistant', text: '发送失败: ' + String(e) },
        ])
      }
    },
    [index, chatSessionId, chatStreaming],
  )

  // ── Ask AI with a specific result ─────────────────────────────────────
  const askAiWithResult = useCallback(
    (result: SearchResult) => {
      setChatOpen(true)
      const prompt = `请解读这篇文档的核心内容:\n\n标题: ${result.doc.title}\n\n${result.doc.content.slice(0, 600)}`
      sendChatMessage(prompt, [
        { title: result.doc.title, content: result.doc.content },
      ])
    },
    [sendChatMessage],
  )

  // ── Derived data ──────────────────────────────────────────────────────
  const maxScore = useMemo(
    () => (results.length > 0 ? results[0].score : 1),
    [results],
  )

  const indexSizeKB = useMemo(() => {
    try {
      const stored = localStorage.getItem(INDEX_STORAGE_KEY)
      if (stored) return Math.round(stored.length / 1024)
    } catch { /* */ }
    return 0
  }, [index])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2 flex-shrink-0">
        <h2 className="text-[13px] font-bold text-ink">向量检索</h2>
        <span className="text-[11px] text-ink-dim">
          RAG 混合搜索 — 关键词 + 语义
        </span>
        <div className="flex-1" />
        <button
          className={BTN_SECONDARY}
          onClick={() => setChatOpen(!chatOpen)}
        >
          {chatOpen ? '关闭问答' : '打开 RAG 问答'}
        </button>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Left: Search + Results ──────────────────────────────────── */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Search bar */}
          <div className="border-b border-line px-4 py-3 flex-shrink-0">
            <div className="flex items-center gap-2">
              <input
                className={INPUT + ' flex-1 !text-[13px] !py-2'}
                placeholder="搜索知识库文档…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button className={BTN_PRIMARY} onClick={doSearch} disabled={indexing}>
                搜索
              </button>
              <span className="text-[10px] text-ink-faint">Enter</span>
            </div>

            {/* Mode toggle */}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-ink-muted mr-1">模式:</span>
              {([
                ['keyword', '关键词'],
                ['semantic', '语义'],
                ['hybrid', '混合'],
              ] as [SearchMode, string][]).map(([m, label]) => (
                <button
                  key={m}
                  className={CHIP_BASE + ' ' + (mode === m ? CHIP_ACTIVE : CHIP_INACTIVE)}
                  onClick={() => setMode(m)}
                >
                  {label}
                </button>
              ))}

              {mode === 'hybrid' && (
                <div className="ml-3 flex items-center gap-1.5">
                  <span className="text-[10px] text-ink-faint">词</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={alpha}
                    onChange={(e) => setAlpha(parseFloat(e.target.value))}
                    className="w-20 h-1 accent-primary"
                  />
                  <span className="text-[10px] text-ink-faint">义</span>
                  <span className="text-[10px] text-ink-muted ml-1">
                    ({Math.round((1 - alpha) * 100)}:{Math.round(alpha * 100)})
                  </span>
                </div>
              )}
            </div>

            {/* Filter pills */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-ink-muted mr-1">筛选:</span>

              {/* Category filter */}
              <select
                className="rounded-chip border border-line bg-editor px-2 py-0.5 text-[10.5px] text-ink outline-none focus:border-primary/60"
                value={filterCategory || ''}
                onChange={(e) => setFilterCategory(e.target.value || null)}
              >
                <option value="">全部分类</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              {/* Tag filter */}
              <select
                className="rounded-chip border border-line bg-editor px-2 py-0.5 text-[10.5px] text-ink outline-none focus:border-primary/60"
                value={filterTag || ''}
                onChange={(e) => setFilterTag(e.target.value || null)}
              >
                <option value="">全部标签</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>

              {/* Starred */}
              <button
                className={
                  CHIP_BASE + ' ' +
                  (filterStarred ? CHIP_ACTIVE : CHIP_INACTIVE)
                }
                onClick={() => setFilterStarred(!filterStarred)}
              >
                {filterStarred ? '★ 已收藏' : '☆ 收藏'}
              </button>

              {/* Date range */}
              <input
                type="date"
                className="rounded-chip border border-line bg-editor px-1.5 py-0.5 text-[10px] text-ink outline-none focus:border-primary/60"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                title="起始日期"
              />
              <span className="text-[10px] text-ink-faint">—</span>
              <input
                type="date"
                className="rounded-chip border border-line bg-editor px-1.5 py-0.5 text-[10px] text-ink outline-none focus:border-primary/60"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                title="截止日期"
              />
            </div>
          </div>

          {/* Index status bar */}
          <div className="flex items-center gap-3 border-b border-line bg-bg px-4 py-1.5 flex-shrink-0">
            <span className="text-[11px] text-ink-muted">
              已索引: <span className="text-ink font-medium">{index?.totalDocs ?? 0}</span> 篇
            </span>
            <span className="text-[11px] text-ink-muted">
              大小: <span className="text-ink font-medium">{indexSizeKB} KB</span>
            </span>
            {index && (
              <span className="text-[11px] text-ink-muted">
                更新于: <span className="text-ink font-medium">
                  {new Date(index.builtAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
            )}
            <div className="flex-1" />
            {indexing && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-32 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-running transition-all duration-300"
                    style={{ width: `${indexProgress}%` }}
                  />
                </div>
                <span className="text-[10px] text-ink-dim">{indexProgress}%</span>
              </div>
            )}
            <button
              className={BTN_SECONDARY + ' !text-[10.5px] !px-2 !py-0.5'}
              onClick={rebuildIndex}
              disabled={indexing}
            >
              {indexing ? '索引中…' : '重建索引'}
            </button>
          </div>

          {/* Results area */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {!searched && !indexing && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="text-[32px] mb-2 opacity-20">&#x1F50D;</div>
                <p className="text-[12px] text-ink-dim">
                  输入查询词，按 Enter 搜索知识库文档
                </p>
                <p className="text-[11px] text-ink-faint mt-1">
                  支持关键词、语义和混合检索模式
                </p>
              </div>
            )}

            {searched && results.length === 0 && (
              <div className="flex flex-col items-center justify-center h-40 text-center">
                <p className="text-[12px] text-ink-dim">未找到匹配的文档</p>
                <p className="text-[11px] text-ink-faint mt-1">
                  尝试更换关键词或切换检索模式
                </p>
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] text-ink-muted mb-2">
                  找到 {results.length} 条结果
                </p>
                {results.map((r, i) => {
                  const pct = scoreToPercent(r.score, maxScore)
                  const excerpt = highlightExcerpt(r.doc.content, r.matchedTerms)
                  return (
                    <div key={r.doc.id} className={CARD + ' hover:border-primary/40 transition-colors'}>
                      <div className="flex items-start gap-3">
                        {/* Rank badge */}
                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary-tint flex items-center justify-center">
                          <span className="text-[11px] font-bold text-primary">
                            {i + 1}
                          </span>
                        </div>

                        <div className="flex-1 min-w-0">
                          {/* Title row */}
                          <div className="flex items-center gap-2">
                            <h3 className="text-[12px] font-semibold text-ink truncate">
                              {r.doc.title}
                            </h3>
                            {r.doc.starred && (
                              <span className="text-[10px] text-awaiting flex-shrink-0">
                                ★
                              </span>
                            )}
                          </div>

                          {/* Excerpt with highlighting */}
                          <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
                            {excerpt.before}
                            {excerpt.match && (
                              <span className="bg-awaiting/20 text-ink font-medium px-0.5 rounded">
                                {excerpt.match}
                              </span>
                            )}
                            {excerpt.after}
                          </p>

                          {/* Meta row */}
                          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
                            {/* Relevance score */}
                            <div className="flex items-center gap-1.5">
                              <div className="w-16 h-1 rounded-full bg-surface-2 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-done transition-all"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-done font-medium">
                                {pct}
                              </span>
                            </div>

                            {/* BM25 / Semantic breakdown in hybrid mode */}
                            {mode === 'hybrid' && (
                              <span className="text-[10px] text-ink-faint">
                                词{Math.round(r.bm25Score * 100)} / 义{Math.round(r.semanticScore * 100)}
                              </span>
                            )}

                            {/* File path */}
                            {r.doc.filePath && (
                              <span
                                className="text-[10px] text-ink-faint truncate max-w-[200px]"
                                title={r.doc.filePath}
                              >
                                {r.doc.filePath.split(/[/\\]/).pop()}
                              </span>
                            )}

                            {/* Tags */}
                            {r.doc.tags.length > 0 && (
                              <div className="flex items-center gap-1">
                                {r.doc.tags.slice(0, 3).map((tag) => (
                                  <span
                                    key={tag}
                                    className="text-[9px] px-1.5 py-px rounded bg-surface-2 text-ink-dim"
                                  >
                                    {tag}
                                  </span>
                                ))}
                                {r.doc.tags.length > 3 && (
                                  <span className="text-[9px] text-ink-faint">
                                    +{r.doc.tags.length - 3}
                                  </span>
                                )}
                              </div>
                            )}

                            <div className="flex-1" />

                            {/* Ask AI button */}
                            <button
                              className="text-[10px] px-2 py-0.5 rounded-chip border border-primary/30 text-primary hover:bg-primary-tint transition-colors"
                              onClick={() => askAiWithResult(r)}
                            >
                              问AI
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: RAG Chat Panel ───────────────────────────────────── */}
        {chatOpen && (
          <div className="w-[360px] flex-shrink-0 border-l border-line flex flex-col bg-bg">
            {/* Chat header */}
            <div className="flex items-center gap-2 border-b border-line px-3 py-2 bg-surface flex-shrink-0">
              <h3 className="text-[12px] font-semibold text-ink">RAG 问答</h3>
              <span className="text-[10px] text-ink-faint">
                自动检索相关文档
              </span>
              <div className="flex-1" />
              <button
                className="text-[10px] text-ink-dim hover:text-ink transition-colors"
                onClick={() => {
                  setChatMessages([])
                  setChatSessionId(null)
                }}
                title="清空对话"
              >
                清空
              </button>
            </div>

            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0">
              {chatMessages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <p className="text-[11px] text-ink-dim">
                    向 AI 提问，系统会自动检索知识库中的相关文档作为上下文
                  </p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i}>
                  {msg.role === 'user' ? (
                    <div className="flex flex-col items-end">
                      <div className="max-w-[85%] rounded-card bg-primary px-3 py-2 text-[11px] text-white leading-relaxed whitespace-pre-wrap">
                        {msg.text}
                      </div>
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1 justify-end max-w-[85%]">
                          {msg.citations.map((c, ci) => (
                            <span
                              key={ci}
                              className="text-[9px] px-1.5 py-px rounded bg-primary-tint text-primary truncate max-w-[140px]"
                              title={c}
                            >
                              [{ci + 1}] {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-start">
                      <div className="max-w-[85%] rounded-card bg-surface border border-line px-3 py-2 text-[11px] text-ink leading-relaxed whitespace-pre-wrap">
                        {msg.text || (chatStreaming && i === chatMessages.length - 1 ? (
                          <span className="text-ink-faint animate-pulse">思考中…</span>
                        ) : '')}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="border-t border-line px-3 py-2 bg-surface flex-shrink-0">
              <div className="flex items-center gap-2">
                <input
                  className={INPUT + ' flex-1'}
                  placeholder="基于知识库提问…"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (chatInput.trim()) {
                        sendChatMessage(chatInput.trim())
                        setChatInput('')
                      }
                    }
                  }}
                  disabled={chatStreaming}
                />
                <button
                  className={BTN_PRIMARY + ' !px-2.5'}
                  onClick={() => {
                    if (chatInput.trim()) {
                      sendChatMessage(chatInput.trim())
                      setChatInput('')
                    }
                  }}
                  disabled={chatStreaming || !chatInput.trim()}
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
