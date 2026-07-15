import { useEffect, useMemo, useState } from 'react'
import { useTrendsStore, type TrendItem, type TrendSource, type TrendSourceKind } from '../stores/trendsStore'

function relTime(ts: number): string {
  if (!ts) return '-'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  return new Date(ts).toLocaleString('zh-CN')
}

function keywordsText(src: TrendSource): string {
  return src.keywords.length > 0 ? src.keywords.join(', ') : '全部'
}

async function openUrl(url: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external_url', { url })
  } catch {
    window.open(url, '_blank')
  }
}

function SourceEditor() {
  const addSource = useTrendsStore((s) => s.addSource)
  const selectedId = useTrendsStore((s) => s.selectedSourceId)
  const sources = useTrendsStore((s) => s.sources)
  const updateSource = useTrendsStore((s) => s.updateSource)
  const selected = sources.find((s) => s.id === selectedId) ?? null
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TrendSourceKind>('platform')
  const [url, setUrl] = useState('')
  const [platformId, setPlatformId] = useState('zhihu')
  const [apiUrl, setApiUrl] = useState('https://newsnow.busiyi.world/api/s')
  const [expectedDomain, setExpectedDomain] = useState('zhihu.com')
  const [keywords, setKeywords] = useState('')
  const [intervalMin, setIntervalMin] = useState(30)

  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setKind(selected.kind)
    setUrl(selected.url)
    setPlatformId(selected.platformId ?? '')
    setApiUrl(selected.apiUrl ?? 'https://newsnow.busiyi.world/api/s')
    setExpectedDomain(selected.expectedDomain ?? '')
    setKeywords(selected.keywords.join(', '))
    setIntervalMin(selected.intervalMin)
  }, [selected?.id])

  const save = () => {
    const ks = keywords.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean)
    if (selected) {
      updateSource(selected.id, { name: name.trim() || '未命名源', kind, url, platformId, apiUrl, expectedDomain, keywords: ks, intervalMin: Math.max(1, intervalMin) })
    } else {
      addSource({ name: name.trim() || '未命名源', kind, url, platformId, apiUrl, expectedDomain, keywords: ks, intervalMin: Math.max(1, intervalMin), enabled: true })
    }
    if (!selected) {
      setName('')
      setKind('platform')
      setUrl('')
      setPlatformId('zhihu')
      setApiUrl('https://newsnow.busiyi.world/api/s')
      setExpectedDomain('zhihu.com')
      setKeywords('')
      setIntervalMin(30)
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <h2 className="text-[13px] font-semibold text-ink mb-2">{selected ? '编辑源' : '新增源'}</h2>
      <div className="space-y-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="源名称" className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
        <select value={kind} onChange={(e) => setKind(e.target.value as TrendSourceKind)} className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60">
          <option value="platform">TrendRadar / newsnow 热榜平台</option>
          <option value="rss">RSS Feed</option>
          <option value="web">普通网页链接抽取</option>
        </select>
        {kind === 'platform' ? (
          <>
            <input value={platformId} onChange={(e) => setPlatformId(e.target.value)} placeholder="平台 ID，如 zhihu / weibo / baidu / toutiao" className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="newsnow API，默认 https://newsnow.busiyi.world/api/s" className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
            <input value={expectedDomain} onChange={(e) => setExpectedDomain(e.target.value)} placeholder="安全校验域名，如 zhihu.com" className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
          </>
        ) : (
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com 或 RSS 地址" className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
        )}
        <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="关键词过滤，用逗号分隔；留空抓取全部" className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-dim">间隔</span>
          <input type="number" min={1} value={intervalMin} onChange={(e) => setIntervalMin(parseInt(e.target.value, 10) || 30)} className="w-20 rounded-input border border-line bg-editor px-2 py-1 text-[12px] text-ink outline-none" />
          <span className="text-[11px] text-ink-dim flex-1">分钟</span>
          <button onClick={save} disabled={kind === 'platform' ? !platformId.trim() : !url.trim()} className="rounded-btn bg-primary px-3 py-1.5 text-[12px] text-white disabled:opacity-40">保存</button>
        </div>
      </div>
    </div>
  )
}

function SourceList() {
  const sources = useTrendsStore((s) => s.sources)
  const selectedId = useTrendsStore((s) => s.selectedSourceId)
  const setSelected = useTrendsStore((s) => s.setSelectedSourceId)
  const updateSource = useTrendsStore((s) => s.updateSource)
  const removeSource = useTrendsStore((s) => s.removeSource)
  const fetchSource = useTrendsStore((s) => s.fetchSource)

  return (
    <div className="rounded-card border border-line bg-surface min-h-0 flex flex-col">
      <div className="px-3 py-2 border-b border-line text-[13px] font-semibold text-ink">推送源</div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {sources.map((src) => (
          <button key={src.id} onClick={() => setSelected(src.id)} className={['w-full rounded-card border px-3 py-2 text-left transition-colors', selectedId === src.id ? 'border-primary/40 bg-primary-tint' : 'border-line bg-editor hover:bg-surface-2'].join(' ')}>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-ink">{src.name}</span>
              <span className={src.enabled ? 'text-[10px] text-done' : 'text-[10px] text-ink-faint'}>{src.enabled ? '启用' : '停用'}</span>
            </div>
            <div className="mt-1 text-[10.5px] text-ink-dim truncate" title={src.kind === 'platform' ? src.platformId : src.url}>{src.kind === 'platform' ? 'newsnow:' + src.platformId : src.url}</div>
            <div className="mt-1 text-[10.5px] text-ink-faint">{src.kind} · 关键词：{keywordsText(src)} · {src.lastFetchedAt ? relTime(src.lastFetchedAt) : '未抓取'}</div>
            {src.error && <div className="mt-1 text-[10.5px] text-failed truncate">{src.error}</div>}
            <div className="mt-2 flex gap-1.5">
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); updateSource(src.id, { enabled: !src.enabled }) }} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-ink-muted hover:text-ink">{src.enabled ? '停用' : '启用'}</span>
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); void fetchSource(src.id) }} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-primary hover:bg-primary-tint">抓取</span>
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); removeSource(src.id) }} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-failed hover:bg-failed/10">删除</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TrendRow({ item }: { item: TrendItem }) {
  const markRead = useTrendsStore((s) => s.markRead)
  const togglePin = useTrendsStore((s) => s.togglePin)
  return (
    <div className={['rounded-card border border-line px-3 py-2 transition-colors', item.read ? 'bg-surface/60 opacity-75' : 'bg-surface'].join(' ')}>
      <div className="flex items-start gap-2">
        <button onClick={() => togglePin(item.id)} className={item.pinned ? 'text-primary' : 'text-ink-faint hover:text-primary'} title="置顶">★</button>
        <button onClick={() => { markRead(item.id, true); void openUrl(item.url) }} className="flex-1 text-left">
          <div className="text-[13px] font-medium text-ink leading-5">{item.title}</div>
          {item.snippet && <div className="mt-1 text-[11.5px] text-ink-muted leading-5 line-clamp-2">{item.snippet}</div>}
        </button>
        <button onClick={() => markRead(item.id, !item.read)} className="rounded-btn border border-line px-2 py-0.5 text-[10.5px] text-ink-muted hover:text-ink">{item.read ? '未读' : '已读'}</button>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-faint">
        <span>{item.sourceName}</span>
        <span>{relTime(item.fetchedAt)}</span>
        <span className="truncate font-mono" title={item.url}>{item.url}</span>
      </div>
    </div>
  )
}

export default function Trends() {
  const hydrate = useTrendsStore((s) => s.hydrate)
  const sources = useTrendsStore((s) => s.sources)
  const items = useTrendsStore((s) => s.items)
  const running = useTrendsStore((s) => s.running)
  const autoRefresh = useTrendsStore((s) => s.autoRefresh)
  const setAutoRefresh = useTrendsStore((s) => s.setAutoRefresh)
  const query = useTrendsStore((s) => s.query)
  const setQuery = useTrendsStore((s) => s.setQuery)
  const fetchAll = useTrendsStore((s) => s.fetchAll)
  const clearRead = useTrendsStore((s) => s.clearRead)

  useEffect(() => { hydrate() }, [hydrate])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      const due = sources.some((s) => s.enabled && (!s.lastFetchedAt || now - s.lastFetchedAt >= s.intervalMin * 60_000))
      if (due) void fetchAll()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, sources, fetchAll])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => (it.title + ' ' + it.snippet + ' ' + it.sourceName).toLowerCase().includes(q))
  }, [items, query])

  const unread = items.filter((it) => !it.read).length

  return (
    <div className="h-full min-h-0 flex flex-col bg-editor text-ink">
      <header className="flex-shrink-0 border-b border-line px-4 py-3 flex items-center gap-3">
        <div>
          <h1 className="text-base font-bold text-ink">热点推送</h1>
          <p className="text-[11px] text-ink-dim mt-0.5">定时抓取指定网页/RSS 的热点内容，支持关键词过滤与本地已读管理</p>
        </div>
        <div className="flex-1" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索热点..." className="w-64 rounded-input border border-line bg-surface px-3 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60" />
        <button onClick={() => setAutoRefresh(!autoRefresh)} className={['rounded-btn border px-3 py-1.5 text-[12px]', autoRefresh ? 'border-primary/40 bg-primary-tint text-primary' : 'border-line bg-surface text-ink-muted'].join(' ')}>{autoRefresh ? '自动刷新开' : '自动刷新关'}</button>
        <button onClick={() => void fetchAll()} disabled={running} className="rounded-btn bg-primary px-3 py-1.5 text-[12px] text-white disabled:opacity-40">{running ? '抓取中...' : '立即抓取'}</button>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[340px_minmax(0,1fr)] gap-4 p-4">
        <aside className="min-h-0 flex flex-col gap-3">
          <SourceEditor />
          <SourceList />
        </aside>
        <main className="min-h-0 flex flex-col rounded-card border border-line bg-editor">
          <div className="flex-shrink-0 px-3 py-2 border-b border-line flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink flex-1">热点列表</h2>
            <span className="text-[11px] text-ink-dim">未读 {unread} · 共 {items.length}</span>
            <button onClick={clearRead} className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-muted hover:text-ink">清理已读</button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            {filtered.length === 0 ? <div className="h-full flex items-center justify-center text-[12px] text-ink-dim">暂无热点。添加源后点击「立即抓取」。</div> : filtered.map((item) => <TrendRow key={item.id} item={item} />)}
          </div>
        </main>
      </div>
    </div>
  )
}
