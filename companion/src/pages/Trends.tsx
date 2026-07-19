import { useState } from 'react'
import { Link } from 'react-router-dom'

/* ── Mock data ──────────────────────────────────────────────────────────────── */

const trendingTopics = [
  { rank: 1, title: 'GPT-5.5 发布引爆全网讨论', source: 'GitHub', heat: 98 },
  { rank: 2, title: 'Claude Code 开源 Agent SDK', source: '知乎', heat: 92 },
  { rank: 3, title: '苹果 WWDC26 AI 功能全解析', source: '微博', heat: 88 },
  { rank: 4, title: '国产大模型新一轮价格战', source: '知乎', heat: 85 },
  { rank: 5, title: 'Rust 2024 Edition 正式发布', source: 'GitHub', heat: 79 },
  { rank: 6, title: 'Capacitor 7 重大更新', source: 'GitHub', heat: 73 },
  { rank: 7, title: '跨境电商 AI 选品工具对比', source: '微博', heat: 68 },
  { rank: 8, title: 'MCP 协议生态一周盘点', source: '知乎', heat: 64 },
  { rank: 9, title: 'TypeScript 6.0 Beta 发布', source: 'GitHub', heat: 58 },
  { rank: 10, title: '大模型 Agent 安全白皮书', source: '知乎', heat: 52 },
]

const rssFeeds = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage', lastFetched: '5 分钟前', articles: 30 },
  { name: '少数派', url: 'https://sspai.com/feed', lastFetched: '12 分钟前', articles: 15 },
  { name: 'GitHub Trending', url: 'https://github.com/trending.atom', lastFetched: '8 分钟前', articles: 25 },
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss', lastFetched: '20 分钟前', articles: 18 },
]

const keywords = [
  { word: 'Claude Code', matches: 47, lastMatch: '2 分钟前' },
  { word: 'MCP 协议', matches: 23, lastMatch: '15 分钟前' },
  { word: 'Agent SDK', matches: 18, lastMatch: '8 分钟前' },
  { word: '跨境电商 AI', matches: 12, lastMatch: '32 分钟前' },
]

const sourceBadge: Record<string, { bg: string; text: string }> = {
  'GitHub': { bg: 'bg-ink/8', text: 'text-ink' },
  '微博': { bg: 'bg-coral/10', text: 'text-coral' },
  '知乎': { bg: 'bg-sky/10', text: 'text-sky' },
}

/* ── Component ──────────────────────────────────────────────────────────────── */

const tabs = ['热榜', 'RSS', '关键词'] as const
type Tab = typeof tabs[number]

export default function Trends() {
  const [activeTab, setActiveTab] = useState<Tab>('热榜')
  const [newRssUrl, setNewRssUrl] = useState('')
  const [showRssInput, setShowRssInput] = useState(false)
  const [newKeyword, setNewKeyword] = useState('')
  const [showKwInput, setShowKwInput] = useState(false)

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <Link to="/data" className="text-ink-muted active:text-ink" style={{ textDecoration: 'none' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
          <h1>热点推送</h1>
        </div>
      </div>

      <div className="page-body" style={{ paddingTop: 0 }}>
        {/* Tab bar */}
        <div className="sticky top-0 z-10 flex bg-bg -mx-4 px-4 pt-3 pb-2 border-b border-line-soft gap-1">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === tab
                  ? 'bg-primary text-white shadow-card'
                  : 'text-ink-dim active:bg-surface-2'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="mt-3">
          {/* ── 热榜 ─────────────────────────────────────────────────── */}
          {activeTab === '热榜' && (
            <div className="flex flex-col gap-2 animate-in">
              {trendingTopics.map((topic) => {
                const badge = sourceBadge[topic.source] ?? sourceBadge['GitHub']
                const heatWidth = `${topic.heat}%`
                const rankColor =
                  topic.rank <= 3 ? 'bg-coral text-white' : 'bg-surface-2 text-ink-dim'

                return (
                  <div key={topic.rank} className="card flex items-center gap-3">
                    <span
                      className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${rankColor}`}
                    >
                      {topic.rank}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink leading-snug truncate">
                        {topic.title}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.bg} ${badge.text}`}
                        >
                          {topic.source}
                        </span>
                        <div className="flex-1 h-1 rounded-full bg-surface-2 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-coral/60 transition-all duration-500"
                            style={{ width: heatWidth }}
                          />
                        </div>
                        <span className="text-[10px] text-ink-faint font-mono shrink-0">
                          {topic.heat}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── RSS ──────────────────────────────────────────────────── */}
          {activeTab === 'RSS' && (
            <div className="flex flex-col gap-3 animate-in">
              {rssFeeds.map((feed) => (
                <div key={feed.url} className="card flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-ink">{feed.name}</p>
                    <span className="badge badge-sky">{feed.articles} 篇</span>
                  </div>
                  <code className="text-[11px] text-ink-dim bg-surface-2 rounded-lg px-2.5 py-1.5 font-mono break-all">
                    {feed.url}
                  </code>
                  <p className="text-[11px] text-ink-faint">
                    上次抓取: {feed.lastFetched}
                  </p>
                </div>
              ))}

              {/* Add RSS input */}
              {showRssInput ? (
                <div className="card flex flex-col gap-2.5">
                  <p className="text-xs font-semibold text-ink">添加 RSS 源</p>
                  <input
                    type="url"
                    className="input"
                    placeholder="https://example.com/feed.xml"
                    value={newRssUrl}
                    onChange={(e) => setNewRssUrl(e.target.value)}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button className="btn btn-primary btn-sm flex-1">添加</button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setShowRssInput(false)
                        setNewRssUrl('')
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-secondary btn-block"
                  onClick={() => setShowRssInput(true)}
                >
                  + 添加 RSS 源
                </button>
              )}
            </div>
          )}

          {/* ── 关键词 ────────────────────────────────────────────────── */}
          {activeTab === '关键词' && (
            <div className="flex flex-col gap-3 animate-in">
              {keywords.map((kw) => (
                <div key={kw.word} className="card flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gold">
                      <circle cx="11" cy="11" r="8" />
                      <path d="M21 21l-4.35-4.35" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink">{kw.word}</p>
                    <p className="text-[11px] text-ink-dim mt-0.5">
                      {kw.matches} 次匹配 &middot; 最近: {kw.lastMatch}
                    </p>
                  </div>
                  <span className="badge badge-gold">{kw.matches}</span>
                </div>
              ))}

              {/* Add keyword input */}
              {showKwInput ? (
                <div className="card flex flex-col gap-2.5">
                  <p className="text-xs font-semibold text-ink">添加关键词</p>
                  <input
                    type="text"
                    className="input"
                    placeholder="输入监控关键词"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button className="btn btn-primary btn-sm flex-1">添加</button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setShowKwInput(false)
                        setNewKeyword('')
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-secondary btn-block"
                  onClick={() => setShowKwInput(true)}
                >
                  + 添加关键词
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
