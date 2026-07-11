// 市场（v0.8）：浏览 VPS 静态市场（Agent / Skills），一键安装到本地。
//   - Agent → 本地注册 + 看板新建「来自市场：<名>」卡片
//   - Skill → 下载到本地技能库（科研页技能库立即可见）
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'

// ── Tauri env guard ───────────────────────────────────────────────────────────

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

// ── 类型（与 src-tauri/src/market.rs 对齐） ──────────────────────────────────

interface MarketAgent {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  file: string
}

interface MarketSkill {
  id: string
  name: string
  description: string
  category: string
  file: string
}

interface MarketIndex {
  version: number
  updated: string
  agents: MarketAgent[]
  skills: MarketSkill[]
}

interface InstalledIds {
  agents: string[]
  skills: string[]
}

interface AgentInstallResult {
  path: string
  taskId: string
}

type Tab = 'agents' | 'skills'

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div className="fixed bottom-5 right-5 z-50 bg-surface-2 border border-line text-ink text-sm px-4 py-3 rounded-xl shadow-xl max-w-xs">
      {message}
    </div>
  )
}

// ── 详情弹窗（md 渲染） ──────────────────────────────────────────────────────

function DetailModal({
  title,
  content,
  loading,
  installed,
  installing,
  onInstall,
  onClose,
}: {
  title: string
  content: string
  loading: boolean
  installed: boolean
  installing: boolean
  onInstall: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="bg-elevated border border-line rounded-pop shadow-pop w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h3 className="text-sm font-semibold text-ink truncate">{title}</h3>
          <div className="flex items-center gap-2">
            {installed ? (
              <span className="text-xs text-primary bg-primary-tint px-2.5 py-1 rounded-full">
                已安装
              </span>
            ) : (
              <button
                onClick={onInstall}
                disabled={installing}
                className="text-xs bg-primary text-white px-3 py-1.5 rounded-btn hover:bg-primary-hover transition-colors disabled:opacity-50"
              >
                {installing ? '安装中…' : '安装'}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-ink-dim hover:text-ink text-lg leading-none px-1"
              title="关闭"
            >
              ×
            </button>
          </div>
        </div>
        <div className="overflow-y-auto px-5 py-4 text-[13px] text-ink leading-relaxed market-md">
          {loading ? (
            <div className="text-ink-dim text-sm py-8 text-center">加载中…</div>
          ) : (
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h1 className="text-base font-bold mt-3 mb-2 text-ink">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-sm font-bold mt-3 mb-1.5 text-ink">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-[13px] font-semibold mt-2 mb-1 text-ink">{children}</h3>
                ),
                p: ({ children }) => <p className="my-1.5">{children}</p>,
                ul: ({ children }) => (
                  <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>
                ),
                code: ({ children }) => (
                  <code className="bg-surface-2 border border-line rounded px-1 py-0.5 text-[12px]">
                    {children}
                  </code>
                ),
                pre: ({ children }) => (
                  <pre className="bg-surface-2 border border-line rounded-lg p-3 my-2 overflow-x-auto text-[12px] whitespace-pre-wrap">
                    {children}
                  </pre>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 条目卡片 ─────────────────────────────────────────────────────────────────

function ItemCard({
  name,
  category,
  description,
  tags,
  installed,
  installing,
  installLabel,
  onOpen,
  onInstall,
}: {
  name: string
  category: string
  description: string
  tags: string[]
  installed: boolean
  installing: boolean
  installLabel: string
  onOpen: () => void
  onInstall: () => void
}) {
  return (
    <div
      className="bg-surface border border-line rounded-card p-4 flex flex-col gap-2 hover:border-primary/50 transition-all cursor-pointer"
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink leading-snug">{name}</h3>
        <span className="text-[10px] text-primary bg-primary-tint px-2 py-0.5 rounded-full flex-shrink-0">
          {category}
        </span>
      </div>
      <p className="text-xs text-ink-muted leading-relaxed line-clamp-3 flex-1">
        {description || '（无描述）'}
      </p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <span
              key={t}
              className="text-[10px] text-ink-dim bg-surface-2 border border-line px-1.5 py-0.5 rounded"
            >
              {t}
            </span>
          ))}
        </div>
        {installed ? (
          <span className="text-[11px] text-primary bg-primary-tint px-2.5 py-1 rounded-full flex-shrink-0">
            已安装
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onInstall()
            }}
            disabled={installing}
            className="text-[11px] bg-primary text-white px-3 py-1 rounded-btn hover:bg-primary-hover transition-colors disabled:opacity-50 flex-shrink-0"
          >
            {installing ? '安装中…' : installLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

export default function Market() {
  const [tab, setTab] = useState<Tab>('agents')
  const [index, setIndex] = useState<MarketIndex | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部')
  const [installedAgents, setInstalledAgents] = useState<Set<string>>(new Set())
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set())
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [detail, setDetail] = useState<{
    kind: Tab
    item: MarketAgent | MarketSkill
    content: string
    loading: boolean
  } | null>(null)

  const load = async () => {
    if (!isTauri) {
      setLoadError('市场功能需要在桌面应用内使用')
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const idx = await tauriInvoke<MarketIndex>('market_index')
      setIndex(idx)
      const inst = await tauriInvoke<InstalledIds>('market_installed')
      setInstalledAgents(new Set(inst.agents))
      setInstalledSkills(new Set(inst.skills))
    } catch (e) {
      setLoadError('市场加载失败：' + String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换标签时重置筛选
  useEffect(() => {
    setCategory('全部')
    setSearch('')
  }, [tab])

  const items: (MarketAgent | MarketSkill)[] = useMemo(() => {
    if (!index) return []
    return tab === 'agents' ? index.agents : index.skills
  }, [index, tab])

  const categories = useMemo(() => {
    const s = new Set<string>()
    items.forEach((it) => it.category && s.add(it.category))
    return ['全部', ...Array.from(s).sort()]
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (category !== '全部' && it.category !== category) return false
      if (!q) return true
      const tags = 'tags' in it ? (it as MarketAgent).tags.join(' ') : ''
      const hay = (it.name + ' ' + it.id + ' ' + it.description + ' ' + tags).toLowerCase()
      return hay.includes(q)
    })
  }, [items, category, search])

  const isInstalled = (it: MarketAgent | MarketSkill) =>
    tab === 'agents' ? installedAgents.has(it.id) : installedSkills.has(it.id)

  const installAgent = async (it: MarketAgent) => {
    setInstallingId(it.id)
    try {
      await tauriInvoke<AgentInstallResult>('market_install_agent', {
        id: it.id,
        name: it.name,
        file: it.file,
      })
      setInstalledAgents((prev) => new Set(prev).add(it.id))
      setToast('已加入看板：' + it.name)
    } catch (e) {
      setToast('安装失败：' + String(e))
    } finally {
      setInstallingId(null)
    }
  }

  const installSkill = async (it: MarketSkill) => {
    setInstallingId(it.id)
    try {
      await tauriInvoke<string>('market_install_skill', { id: it.id, file: it.file })
      setInstalledSkills((prev) => new Set(prev).add(it.id))
      setToast('已下载到本地技能库：' + it.name)
    } catch (e) {
      setToast('下载失败：' + String(e))
    } finally {
      setInstallingId(null)
    }
  }

  const doInstall = (it: MarketAgent | MarketSkill) => {
    if (tab === 'agents') void installAgent(it as MarketAgent)
    else void installSkill(it as MarketSkill)
  }

  const openDetail = async (it: MarketAgent | MarketSkill) => {
    setDetail({ kind: tab, item: it, content: '', loading: true })
    try {
      const md = await tauriInvoke<string>('market_fetch', { file: it.file })
      setDetail((prev) =>
        prev && prev.item.id === it.id ? { ...prev, content: md, loading: false } : prev,
      )
    } catch (e) {
      setDetail((prev) =>
        prev && prev.item.id === it.id
          ? { ...prev, content: '加载失败：' + String(e), loading: false }
          : prev,
      )
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg">
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* 标题 */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold text-ink">市场</h1>
            <p className="text-xs text-ink-muted mt-0.5">
              浏览社区 Agent 与 Skills，一键安装到本地看板 / 技能库
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="text-xs text-ink-muted border border-line bg-surface-2 px-3 py-1.5 rounded-btn hover:border-primary hover:text-primary transition-colors"
          >
            刷新
          </button>
        </div>

        {/* 标签页 + 筛选 */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex bg-surface-2 border border-line rounded-btn p-0.5">
            {(['agents', 'skills'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  'px-4 py-1.5 text-xs rounded-btn transition-colors ' +
                  (tab === t
                    ? 'bg-elevated text-primary font-semibold'
                    : 'text-ink-muted hover:text-ink')
                }
              >
                {t === 'agents' ? 'Agent' : 'Skills'}
              </button>
            ))}
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="text-xs border border-line bg-surface-2 text-ink rounded-btn px-2.5 py-1.5 outline-none focus:border-primary"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称 / 描述 / 标签…"
            className="flex-1 min-w-[180px] text-xs border border-line bg-surface-2 text-ink rounded-btn px-3 py-1.5 outline-none focus:border-primary placeholder:text-ink-dim"
          />
        </div>

        {/* 内容 */}
        {loading ? (
          <div className="text-center text-ink-dim text-sm py-16">市场加载中…</div>
        ) : loadError ? (
          <div className="text-center py-16">
            <p className="text-sm text-failed mb-3">{loadError}</p>
            <button
              onClick={() => void load()}
              className="text-xs bg-primary text-white px-4 py-1.5 rounded-btn hover:bg-primary-hover transition-colors"
            >
              重试
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-ink-dim text-sm py-16">没有匹配的条目</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((it) => (
              <ItemCard
                key={it.id}
                name={it.name}
                category={it.category}
                description={it.description}
                tags={'tags' in it ? (it as MarketAgent).tags : [it.category]}
                installed={isInstalled(it)}
                installing={installingId === it.id}
                installLabel={tab === 'agents' ? '装到看板' : '下载'}
                onOpen={() => void openDetail(it)}
                onInstall={() => doInstall(it)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {detail && (
        <DetailModal
          title={detail.item.name}
          content={detail.content}
          loading={detail.loading}
          installed={
            detail.kind === 'agents'
              ? installedAgents.has(detail.item.id)
              : installedSkills.has(detail.item.id)
          }
          installing={installingId === detail.item.id}
          onInstall={() => doInstall(detail.item)}
          onClose={() => setDetail(null)}
        />
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  )
}
