// Hooks 管理页面 -- 已安装（卸载） + 推荐目录（分类 chip + 搜索），一键安装。
import { useMemo, useState } from 'react'
import { useHooksStore, BUILTIN_HOOKS } from '../stores/hooksStore'
import type { HookCategory, HookDef } from '../stores/hooksStore'
import { Chip } from '../components/ui'
import type { ChipTone } from '../components/ui'

const CATEGORY_LABELS: Record<HookCategory, string> = {
  quality: '代码质量',
  test: '测试',
  deploy: '部署',
  format: '格式化',
  security: '安全',
  workflow: '工作流',
}

const CATEGORY_TONES: Record<HookCategory, ChipTone> = {
  quality: 'primary',
  test: 'sky',
  deploy: 'gold',
  format: 'mint',
  security: 'coral',
  workflow: 'lavender',
}

export default function HooksHub() {
  const installedIds = useHooksStore((s) => s.installedHookIds)
  const install = useHooksStore((s) => s.install)
  const uninstall = useHooksStore((s) => s.uninstall)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<HookCategory | null>(null)

  // 已安装 id 集合
  const installedSet = useMemo(() => new Set(installedIds), [installedIds])

  // 已安装 hook 详情
  const installedHooks = useMemo(
    () => BUILTIN_HOOKS.filter((h) => installedSet.has(h.id)),
    [installedSet],
  )

  // 目录分类统计
  const categories = useMemo(() => {
    const map = new Map<HookCategory, number>()
    for (const e of BUILTIN_HOOKS) {
      map.set(e.category, (map.get(e.category) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [])

  // 过滤后的目录
  const filteredCatalog = useMemo(() => {
    let list: HookDef[] = BUILTIN_HOOKS
    if (category) {
      list = list.filter((e) => e.category === category)
    }
    if (query.trim()) {
      const q = query.toLowerCase()
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.trigger.toLowerCase().includes(q),
      )
    }
    return list
  }, [category, query])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* 顶部标题 + 说明 */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-ink">Hooks 管理</h1>
          <p className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">
            已安装的 Hooks 会自动在编码会话中生效；也可在编码窗口输入{' '}
            <code className="px-1 py-0.5 rounded bg-surface-2 text-ink font-mono text-[11px]">
              /hook:
            </code>{' '}
            手动唤起。
          </p>
        </div>

        {/* ── 已安装区 ──────────────────────────────────────────────────── */}
        <section className="mb-8">
          <h2 className="text-[14px] font-semibold text-ink mb-3">
            已安装
            {installedHooks.length > 0 && (
              <span className="ml-2 text-ink-dim font-normal">
                ({installedHooks.length})
              </span>
            )}
          </h2>
          {installedHooks.length === 0 && (
            <p className="text-[12px] text-ink-dim">
              暂无已安装的 Hook，可从下方推荐目录一键安装。
            </p>
          )}
          {installedHooks.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {installedHooks.map((hook) => (
                <div
                  key={hook.id}
                  className="rounded-card border border-line bg-surface p-4 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[13px] font-semibold text-ink truncate">
                        {hook.name}
                      </h3>
                      <p className="text-[11px] text-ink-muted mt-0.5 line-clamp-2">
                        {hook.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <Chip tone={CATEGORY_TONES[hook.category]}>
                      {CATEGORY_LABELS[hook.category]}
                    </Chip>
                    <span className="text-[10px] text-ink-faint">{hook.trigger}</span>
                    {hook.manualOnly && <Chip tone="gold">手动</Chip>}
                    <span className="flex-1" />
                    <button
                      onClick={() => uninstall(hook.id)}
                      className="text-[10.5px] text-ink-dim hover:text-failed transition-colors"
                      title="卸载此 Hook"
                    >
                      卸载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 推荐目录区 ────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-[14px] font-semibold text-ink mb-3">
            推荐目录
            <span className="ml-2 text-ink-dim font-normal">
              ({BUILTIN_HOOKS.length})
            </span>
          </h2>

          {/* 搜索 + 分类过滤 */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="搜索 Hook 名称、描述、触发时机..."
              className="w-64 rounded-card border border-line bg-surface px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none transition-colors"
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
                onClick={() => setCategory(null)}
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
                  onClick={() => setCategory(category === cat ? null : cat)}
                >
                  {CATEGORY_LABELS[cat]} ({count})
                </button>
              ))}
            </div>
          </div>

          {filteredCatalog.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCatalog.map((hook) => {
                const isInstalled = installedSet.has(hook.id)
                return (
                  <div
                    key={hook.id}
                    className="rounded-card border border-line bg-surface p-4 hover:border-line-strong transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-[13px] font-semibold text-ink truncate">
                          {hook.name}
                        </h3>
                        <p className="text-[11px] text-ink-muted mt-0.5 line-clamp-2">
                          {hook.description}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Chip tone={CATEGORY_TONES[hook.category]}>
                        {CATEGORY_LABELS[hook.category]}
                      </Chip>
                      <span className="text-[10px] text-ink-faint">{hook.trigger}</span>
                      {hook.manualOnly && <Chip tone="gold">手动</Chip>}
                      <span className="flex-1" />
                      {isInstalled ? (
                        <span className="text-[10.5px] text-done font-medium">
                          已安装
                        </span>
                      ) : (
                        <button
                          onClick={() => install(hook.id)}
                          className="text-[10.5px] px-2.5 py-0.5 rounded-btn bg-primary hover:bg-primary-hover text-white transition-colors"
                        >
                          安装
                        </button>
                      )}
                    </div>
                    {/* 触发指令预览 */}
                    <details className="mt-2">
                      <summary className="text-[10px] text-ink-faint cursor-pointer hover:text-ink-dim transition-colors">
                        查看 Agent 指令
                      </summary>
                      <p className="mt-1 text-[10.5px] text-ink-dim bg-surface-2 rounded p-2 leading-relaxed whitespace-pre-wrap">
                        {hook.agentInstruction}
                      </p>
                    </details>
                  </div>
                )
              })}
            </div>
          )}

          {filteredCatalog.length === 0 && (
            <p className="text-[12px] text-ink-dim">没有匹配的 Hook。</p>
          )}
        </section>
      </div>
    </div>
  )
}