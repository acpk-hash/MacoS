// Skills 板块 — 技能市场 + 公开搜索：分类浏览 + 一键安装 + GitHub 公开 skill 搜索。
// 安装到 app_data_dir/skills/<name>/SKILL.md，编码窗口输入 / 即可唤起。
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSkillsStore, normalizedSkillName } from '../stores/skillsStore'
import type { MarketEntry } from '../stores/skillsStore'
import SkillMarketCard from '../components/skills/SkillMarketCard'
import PublicSkillCard from '../components/skills/PublicSkillCard'
import SkillContentModal from '../components/skills/SkillContentModal'
import { Button, Chip } from '../components/ui'

/** 关键词匹配：名称/id/描述/分类/标签任一命中。 */
function matches(e: MarketEntry, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    e.name.toLowerCase().includes(needle) ||
    e.id.toLowerCase().includes(needle) ||
    e.description.toLowerCase().includes(needle) ||
    e.category.toLowerCase().includes(needle) ||
    e.tags.some((t) => t.toLowerCase().includes(needle))
  )
}

type SkillsTab = 'market' | 'public'

export default function Skills() {
  const market = useSkillsStore((s) => s.market)
  const marketLoading = useSkillsStore((s) => s.marketLoading)
  const marketError = useSkillsStore((s) => s.marketError)
  const query = useSkillsStore((s) => s.query)
  const category = useSkillsStore((s) => s.category)
  const installed = useSkillsStore((s) => s.installed)
  const installing = useSkillsStore((s) => s.installing)
  const notice = useSkillsStore((s) => s.notice)
  const viewing = useSkillsStore((s) => s.viewing)
  const viewLoading = useSkillsStore((s) => s.viewLoading)

  const publicQuery = useSkillsStore((s) => s.publicQuery)
  const publicResults = useSkillsStore((s) => s.publicResults)
  const publicSearching = useSkillsStore((s) => s.publicSearching)
  const publicError = useSkillsStore((s) => s.publicError)
  const publicInstalling = useSkillsStore((s) => s.publicInstalling)

  const loadMarket = useSkillsStore((s) => s.loadMarket)
  const loadInstalled = useSkillsStore((s) => s.loadInstalled)
  const install = useSkillsStore((s) => s.install)
  const uninstall = useSkillsStore((s) => s.uninstall)
  const view = useSkillsStore((s) => s.view)
  const closeView = useSkillsStore((s) => s.closeView)
  const setQuery = useSkillsStore((s) => s.setQuery)
  const setCategory = useSkillsStore((s) => s.setCategory)
  const clearNotice = useSkillsStore((s) => s.clearNotice)
  const setPublicQuery = useSkillsStore((s) => s.setPublicQuery)
  const searchPublic = useSkillsStore((s) => s.searchPublic)
  const installPublic = useSkillsStore((s) => s.installPublic)

  const [tab, setTab] = useState<SkillsTab>('market')

  useEffect(() => {
    void loadInstalled()
    if (market.length === 0) void loadMarket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const installedNames = useMemo(
    () => new Set(installed.map((x) => x.name)),
    [installed],
  )

  const categories = useMemo(() => {
    const set = new Map<string, number>()
    for (const e of market) {
      const c = e.category || '未分类'
      set.set(c, (set.get(c) ?? 0) + 1)
    }
    return Array.from(set.entries()).sort((a, b) => b[1] - a[1])
  }, [market])

  const visible = useMemo(
    () =>
      market.filter(
        (e) =>
          matches(e, query.trim()) &&
          (category == null || (e.category || '未分类') === category),
      ),
    [market, query, category],
  )

  const handlePublicSearch = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault()
      void searchPublic()
    },
    [searchPublic],
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-8 pt-10 pb-6">
        <h1 className="text-xl font-bold text-ink">Skills</h1>
        <p className="mt-1 text-sm text-ink-muted">
          技能市场 · 下载即用，编码窗口输入 <span className="font-mono text-ink">/</span> 唤起
        </p>
        {/* ── 统计概览 ── */}
        <div className="mt-3 flex flex-wrap gap-3">
          <span className="rounded-btn border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted">
            本地已安装 <span className="font-semibold text-ink">{installed.length}</span>
          </span>
          <span className="rounded-btn border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted">
            市场 <span className="font-semibold text-ink">{market.length}</span>
          </span>
          <span className="rounded-btn border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted">
            公开搜索 <span className="font-semibold text-ink">{publicResults.length > 0 ? publicResults.length + '+' : 'GitHub'}</span>
          </span>
        </div>
      </div>

      {notice && (
        <div className="mx-8 mb-4 flex items-center justify-between rounded-card border border-line bg-primary-tint px-3.5 py-2 text-[12px] text-ink">
          <span className="min-w-0 truncate">{notice}</span>
          <button
            onClick={clearNotice}
            className="ml-3 flex-shrink-0 text-ink-dim hover:text-ink"
            title="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── 已安装 ── */}
      <section className="px-8 pb-6">
        <h2 className="mb-2.5 text-[13px] font-semibold text-ink">
          已安装 <span className="font-normal text-ink-faint">（{installed.length}）</span>
        </h2>
        {installed.length === 0 ? (
          <p className="rounded-card border border-dashed border-line px-4 py-5 text-center text-[12px] text-ink-dim">
            还没有安装任何技能 — 从下方市场挑一个「安装」，编码窗口输入 / 即可唤起
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {installed.map((sk) => (
              <div
                key={sk.name}
                className="flex items-center gap-3 rounded-card border border-line bg-surface px-3.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12.5px] font-medium text-ink">
                    /skill:{sk.name}
                  </p>
                  <p className="truncate text-[11px] text-ink-muted" title={sk.description}>
                    {sk.description || '（无描述）'}
                  </p>
                </div>
                <Chip tone="done">已安装</Chip>
                <Button size="sm" variant="ghost" onClick={() => void view(sk.name)}>
                  查看
                </Button>
                <Button size="sm" variant="danger" onClick={() => void uninstall(sk.name)}>
                  卸载
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Tab 切换：市场 / 公开搜索 ── */}
      <div className="mx-8 mb-4 flex gap-1 border-b border-line">
        <button
          onClick={() => setTab('market')}
          className={`px-4 py-2 text-[13px] font-medium transition-colors ${
            tab === 'market'
              ? 'border-b-2 border-primary text-ink'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          技能市场 ({market.length})
        </button>
        <button
          onClick={() => setTab('public')}
          className={`px-4 py-2 text-[13px] font-medium transition-colors ${
            tab === 'public'
              ? 'border-b-2 border-primary text-ink'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          公开搜索
        </button>
      </div>

      {tab === 'market' && (
        /* ── 市场 ── */
        <section className="flex-1 px-8 pb-10">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink">
              技能市场 <span className="font-normal text-ink-faint">（{market.length}）</span>
            </h2>
            <div className="flex-1" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称 / 描述 / 分类 / 标签"
              className="w-64 rounded-btn border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint outline-none focus:border-primary/60"
            />
            <Button size="sm" variant="ghost" disabled={marketLoading} onClick={() => void loadMarket()}>
              {marketLoading ? '刷新中…' : '刷新'}
            </Button>
          </div>

          {categories.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              <button onClick={() => setCategory(null)}>
                <Chip tone={category == null ? 'primary' : 'neutral'}>
                  全部 {market.length}
                </Chip>
              </button>
              {categories.map(([c, n]) => (
                <button key={c} onClick={() => setCategory(category === c ? null : c)}>
                  <Chip tone={category === c ? 'primary' : 'neutral'}>
                    {c} {n}
                  </Chip>
                </button>
              ))}
            </div>
          )}

          {marketError ? (
            <div className="rounded-card border border-line bg-surface px-4 py-8 text-center">
              <p className="text-[12.5px] text-failed">{marketError}</p>
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => void loadMarket()}>
                重试
              </Button>
            </div>
          ) : marketLoading && market.length === 0 ? (
            <p className="px-1 py-8 text-center text-[12.5px] text-ink-dim">正在拉取市场清单…</p>
          ) : visible.length === 0 ? (
            <p className="px-1 py-8 text-center text-[12.5px] text-ink-dim">
              没有匹配的技能（换个关键词或分类试试）
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((e) => (
                <SkillMarketCard
                  key={`${e.kind}-${e.id}`}
                  entry={e}
                  installed={installedNames.has(normalizedSkillName(e.id))}
                  installing={!!installing[e.id]}
                  onInstall={(id) => void install(id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'public' && (
        /* ── 公开搜索 ── */
        <section className="flex-1 px-8 pb-10">
          <div className="mb-4">
            <p className="mb-3 text-[12px] text-ink-muted">
              搜索 GitHub 上公开的 AI agent skills（按 claude-skill / ai-skill / agent-skill topic 过滤）
            </p>
            <form onSubmit={handlePublicSearch} className="flex gap-2">
              <input
                value={publicQuery}
                onChange={(e) => setPublicQuery(e.target.value)}
                placeholder="输入关键词搜索公开 Skills（如 code review, testing, docs...）"
                className="flex-1 rounded-btn border border-line bg-surface px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-faint outline-none focus:border-primary/60"
              />
              <Button
                size="sm"
                variant="soft"
                disabled={publicSearching}
                onClick={handlePublicSearch}
              >
                {publicSearching ? '搜索中…' : '搜索'}
              </Button>
            </form>
          </div>

          {publicError && (
            <div className="mb-4 rounded-card border border-line bg-surface px-4 py-3 text-center">
              <p className="text-[12.5px] text-failed">{publicError}</p>
            </div>
          )}

          {publicSearching ? (
            <p className="px-1 py-8 text-center text-[12.5px] text-ink-dim">正在搜索 GitHub…</p>
          ) : publicResults.length === 0 ? (
            <p className="px-1 py-8 text-center text-[12.5px] text-ink-dim">
              输入关键词搜索公开 Skills，或直接点搜索浏览热门 Skills
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {publicResults.map((sk) => (
                <PublicSkillCard
                  key={sk.id}
                  skill={sk}
                  installed={installedNames.has(normalizedSkillName(sk.name))}
                  installing={!!publicInstalling[sk.id]}
                  onInstall={() => void installPublic(sk)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {viewing && (
        <SkillContentModal
          name={viewing.name}
          content={viewing.content}
          loading={viewLoading}
          onClose={closeView}
        />
      )}
    </div>
  )
}