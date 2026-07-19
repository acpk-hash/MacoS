// MCP 管理页面 -- 已安装 + 推荐目录，一键安装/删除，分类过滤+搜索。
import { useEffect, useMemo } from 'react'
import { useMcpStore } from '../stores/mcpStore'
import type { McpCatalogEntry } from '../stores/mcpStore'
import McpInstalledCard from '../components/mcp/McpInstalledCard'
import McpCatalogCard from '../components/mcp/McpCatalogCard'
import McpInstallDialog from '../components/mcp/McpInstallDialog'
// Chip reserved for future use

export default function McpHub() {
  const installed = useMcpStore((s) => s.installed)
  const installedLoading = useMcpStore((s) => s.installedLoading)
  const installedError = useMcpStore((s) => s.installedError)
  const catalog = useMcpStore((s) => s.catalog)
  const catalogLoading = useMcpStore((s) => s.catalogLoading)
  const removing = useMcpStore((s) => s.removing)
  const installing = useMcpStore((s) => s.installing)
  const notice = useMcpStore((s) => s.notice)
  const query = useMcpStore((s) => s.query)
  const category = useMcpStore((s) => s.category)

  const loadInstalled = useMcpStore((s) => s.loadInstalled)
  const loadCatalog = useMcpStore((s) => s.loadCatalog)
  const remove = useMcpStore((s) => s.remove)
  const setQuery = useMcpStore((s) => s.setQuery)
  const setCategory = useMcpStore((s) => s.setCategory)
  const clearNotice = useMcpStore((s) => s.clearNotice)
  const openInstallDialog = useMcpStore((s) => s.openInstallDialog)

  useEffect(() => {
    void loadInstalled()
    if (catalog.length === 0) void loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 自动清除通知
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(clearNotice, 3000)
    return () => clearTimeout(t)
  }, [notice, clearNotice])

  // 已安装名称集合
  const installedNames = useMemo(
    () => new Set(installed.map((s) => s.name)),
    [installed],
  )

  // 目录分类列表
  const categories = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of catalog) {
      const c = e.category || '未分类'
      map.set(c, (map.get(c) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [catalog])

  // 过滤后的目录
  const filteredCatalog = useMemo(() => {
    let list = catalog
    if (category) {
      list = list.filter((e) => e.category === category)
    }
    if (query.trim()) {
      const q = query.toLowerCase()
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q) ||
          (e.description ?? '').toLowerCase().includes(q) ||
          (e.npm_package ?? '').toLowerCase().includes(q) ||
          (e.category ?? '').toLowerCase().includes(q),
      )
    }
    return list
  }, [catalog, category, query])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* 顶部标题 + 说明 */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-ink">MCP 工具管理</h1>
          <p className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">
            MCP 工具会在编码会话中自动可用；需要的 API Key 等环境变量请在安装时填写。
          </p>
        </div>

        {/* 通知条 */}
        {notice && (
          <div className="mb-4 rounded-card border border-line bg-surface px-4 py-2.5 text-[12px] text-ink-muted">
            {notice}
          </div>
        )}

        {/* ── 已安装区 ──────────────────────────────────────────────────── */}
        <section className="mb-8">
          <h2 className="text-[14px] font-semibold text-ink mb-3">
            已安装
            {installed.length > 0 && (
              <span className="ml-2 text-ink-dim font-normal">({installed.length})</span>
            )}
          </h2>
          {installedLoading && (
            <p className="text-[12px] text-ink-dim">加载中...</p>
          )}
          {installedError && (
            <p className="text-[12px] text-failed">{installedError}</p>
          )}
          {!installedLoading && installed.length === 0 && !installedError && (
            <p className="text-[12px] text-ink-dim">暂无已安装的 MCP 工具，可从下方推荐目录一键安装。</p>
          )}
          {installed.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {installed.map((s) => (
                <McpInstalledCard
                  key={s.name}
                  server={s}
                  removing={removing === s.name}
                  onRemove={(name) => void remove(name)}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── 推荐目录区 ────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-[14px] font-semibold text-ink mb-3">
            推荐目录
            {catalog.length > 0 && (
              <span className="ml-2 text-ink-dim font-normal">({catalog.length})</span>
            )}
          </h2>

          {/* 搜索 + 分类过滤 */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="搜索工具名、包名、描述..."
              className="w-64 rounded-card border border-line bg-surface px-3 py-1.5 text-[12px] text-ink
                         placeholder:text-ink-faint focus:border-primary focus:outline-none transition-colors"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              <button
                className={`text-[10.5px] px-2 py-0.5 rounded-chip border transition-colors ${
                  !category
                    ? 'bg-primary-tint text-primary border-primary/25 font-medium'
                    : 'bg-surface-2 text-ink-muted border-line hover:border-line-strong'
                }`}
                onClick={() => setCategory('')}
              >
                全部
              </button>
              {categories.map(([cat, count]) => (
                <button
                  key={cat}
                  className={`text-[10.5px] px-2 py-0.5 rounded-chip border transition-colors ${
                    category === cat
                      ? 'bg-primary-tint text-primary border-primary/25 font-medium'
                      : 'bg-surface-2 text-ink-muted border-line hover:border-line-strong'
                  }`}
                  onClick={() => setCategory(category === cat ? '' : cat)}
                >
                  {cat} ({count})
                </button>
              ))}
            </div>
          </div>

          {catalogLoading && (
            <p className="text-[12px] text-ink-dim">加载目录中...</p>
          )}

          {filteredCatalog.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCatalog.map((entry) => (
                <McpCatalogCard
                  key={entry.id}
                  entry={entry}
                  installed={installedNames.has(entry.id)}
                  installing={installing === entry.id}
                  onInstall={(e: McpCatalogEntry) => openInstallDialog(e)}
                />
              ))}
            </div>
          )}

          {!catalogLoading && filteredCatalog.length === 0 && catalog.length > 0 && (
            <p className="text-[12px] text-ink-dim">没有匹配的工具。</p>
          )}
        </section>
      </div>

      {/* 安装对话框 */}
      <McpInstallDialog />
    </div>
  )
}
