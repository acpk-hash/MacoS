import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useStudioStore,
  type AggModel,
  type GenMediaRow,
} from '../stores/studioStore'
import { useImageStore } from '../stores/imageStore'
import PromptBuilder from '../components/image/PromptBuilder'
import ReferencePanel from '../components/image/ReferencePanel'
import AnnotatorModal from '../components/image/AnnotatorModal'
import MediaCard from '../components/image/MediaCard'
import FilterBar, { rangeStart, type TimeRange } from '../components/image/FilterBar'
import Lightbox from '../components/image/Lightbox'
import { downloadMedia, sizeOf } from '../components/image/mediaUtils'
import { Mascot } from '../components/ui'

// 图像板块 — Prompt 工作台（左）+ 画廊筛选浏览（右）。
// 生成面板 / 画廊 / 灯箱恢复自 698a026 StudioGen 的图像部分（视频 tab 已去除，
// 视频板块另有占位页）；筛选条与收藏为本次新增。

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const

const EXAMPLE_IMAGE_PROMPTS = [
  '一只戴着宇航头盔的柴犬，漂浮在霓虹星云中，超现实主义，高细节',
  '江南水乡清晨，薄雾中的石桥与乌篷船，水彩画风格，柔和光线',
  '极简主义产品渲染：一台悬浮的复古相机，柔和渐变背景，工作室灯光',
]

/** 按服务商分组，供模型下拉的 optgroup 使用。 */
function groupByProvider(
  models: AggModel[],
): { providerId: string; providerLabel: string; items: AggModel[] }[] {
  const groups: { providerId: string; providerLabel: string; items: AggModel[] }[] = []
  for (const m of models) {
    const g = groups.find((x) => x.providerId === m.providerId)
    if (g) g.items.push(m)
    else
      groups.push({
        providerId: m.providerId,
        providerLabel: m.providerLabel,
        items: [m],
      })
  }
  return groups
}

export default function ImageStudio() {
  const {
    aggModels,
    modelsLoaded,
    media,
    mediaLoaded,
    loadModels,
    loadMedia,
    deleteMedia,
  } = useStudioStore()
  // 生成面板状态（草稿/模型/尺寸/数量/参考/标注工作台）全在 imageStore ——
  // 离开页面回来完整恢复；生成与再加工任务在 store 内后台继续跑。
  const {
    favoriteIds,
    toggleFavorite,
    removeFavorite,
    draft,
    setDraft,
    imageModel,
    imageProviderId,
    setImageSel,
    size,
    setSize,
    count,
    setCount,
    assembling,
    generate,
    annotator,
    openAnnotator,
    closeAnnotator,
  } = useImageStore()

  // ── 画廊筛选状态 ────────────────────────────────────────────────────────────
  const [filterModel, setFilterModel] = useState('')
  const [range, setRange] = useState<TimeRange>('all')
  const [keyword, setKeyword] = useState('')
  const [favOnly, setFavOnly] = useState(false)

  // ── 其它 UI 状态 ────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<GenMediaRow | null>(null)
  const toastTimer = useRef<number | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)

  const imageModels = useMemo(
    () => aggModels.filter((m) => m.kind === 'image'),
    [aggModels],
  )
  const modelGroups = useMemo(() => groupByProvider(imageModels), [imageModels])
  // 已加载完成但没有任何服务商 / 可用模型（首启或全部失败）。
  const noProviders = modelsLoaded && aggModels.length === 0

  const favSet = useMemo(() => new Set(favoriteIds), [favoriteIds])

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  // 初始加载。
  useEffect(() => {
    if (!isTauri) return
    loadModels()
    loadMedia('image')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 模型列表就绪后保持选中项有效。
  useEffect(() => {
    if (imageModels.length === 0) return
    if (!imageModel || !imageModels.some((m) => m.modelId === imageModel)) {
      setImageSel(imageModels[0].providerId, imageModels[0].modelId)
    }
  }, [imageModels, imageModel])

  // ── 筛选（实时生效） ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const since = rangeStart(range, Date.now())
    return media.filter((m) => {
      if (filterModel && m.model !== filterModel) return false
      if (since && m.created_at < since) return false
      if (kw && !m.prompt.toLowerCase().includes(kw)) return false
      if (favOnly && !favSet.has(m.id)) return false
      return true
    })
  }, [media, filterModel, range, keyword, favOnly, favSet])

  const hasActiveFilter = !!filterModel || range !== 'all' || !!keyword.trim() || favOnly
  const clearFilters = () => {
    setFilterModel('')
    setRange('all')
    setKeyword('')
    setFavOnly(false)
  }

  /** 历史记录中出现过的模型（用于筛选下拉）。 */
  const galleryModels = useMemo(
    () => Array.from(new Set(media.map((m) => m.model).filter(Boolean))),
    [media],
  )

  // 可进入灯箱的条目（已完成且有本地文件），跟随当前筛选结果。
  const doneItems = useMemo(
    () => filtered.filter((m) => m.status === 'done' && m.local_path),
    [filtered],
  )

  // 条目增删后保持灯箱索引在范围内。
  useEffect(() => {
    if (lightboxIdx == null) return
    if (doneItems.length === 0) setLightboxIdx(null)
    else if (lightboxIdx >= doneItems.length) setLightboxIdx(doneItems.length - 1)
  }, [doneItems.length, lightboxIdx])

  // 再加工工作台的源图记录；源图被删或缺文件时自动关闭工作台。
  const annotatorRow = useMemo(
    () =>
      annotator
        ? media.find(
            (m) =>
              m.id === annotator.sourceId &&
              m.status === 'done' &&
              !!m.local_path,
          ) ?? null
        : null,
    [annotator, media],
  )
  useEffect(() => {
    if (annotator && mediaLoaded && !annotatorRow) closeAnnotator()
  }, [annotator, annotatorRow, mediaLoaded, closeAnnotator])

  // ── 动作 ────────────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!draft.trim() || assembling) return
    if (!imageModel) {
      showToast('当前没有可用的图像模型')
      return
    }
    // 组装（含等待参考图风格分析收尾）后即返回；生成本体在后台跑，
    // 挂全局任务条（module: image），离开页面不中断。
    const warn = await generate()
    showToast(warn ?? '已提交生成任务，完成后自动入画廊')
  }

  const handleRetry = (row: GenMediaRow) => {
    setDraft(row.prompt)
    const s = sizeOf(row)
    if (s) setSize(s)
    const match = row.model
      ? imageModels.find((m) => m.modelId === row.model)
      : undefined
    if (match) setImageSel(match.providerId, match.modelId)
    draftRef.current?.focus()
    showToast('已回填参数，可重新生成')
  }

  const copyPrompt = async (row: GenMediaRow) => {
    try {
      await navigator.clipboard.writeText(row.prompt)
      showToast('已复制提示词')
    } catch {
      showToast('复制失败')
    }
  }

  const openLightbox = (row: GenMediaRow) => {
    const i = doneItems.findIndex((m) => m.id === row.id)
    if (i >= 0) setLightboxIdx(i)
  }

  const doDelete = (id: string) => {
    void deleteMedia(id)
    removeFavorite(id)
  }

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
        <p className="text-ink-dim text-xs">
          此功能需要 Tauri 桌面运行时，无法在普通浏览器中运行。
        </p>
      </div>
    )
  }

  const selCls =
    'bg-surface-2 border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-lavender transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const canGenerate = !!draft.trim() && !!imageModel && !assembling

  return (
    <div className="flex h-full min-h-0">
      {/* ── 左：Prompt 工作台 ── */}
      <aside className="w-[340px] flex-shrink-0 border-r border-line flex flex-col min-h-0">
        <div className="px-4 pt-5 pb-3 flex-shrink-0">
          <h1 className="text-lg font-bold text-ink">图像</h1>
          <p className="mt-0.5 text-xs text-ink-muted">AI 图像生成工作台</p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col gap-3">
          {/* 提示词输入 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-ink-dim tracking-wide">
              提示词
            </span>
            <textarea
              ref={draftRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void handleGenerate()
                }
              }}
              rows={5}
              placeholder={
                noProviders
                  ? '未配置模型服务——请先到「设置」添加服务商'
                  : modelsLoaded && imageModels.length === 0
                    ? '当前服务商没有可用的图像模型'
                    : '描述你想生成的图像，Ctrl+Enter 生成'
              }
              className="w-full resize-y bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim leading-relaxed focus:outline-none focus:border-lavender transition-colors"
            />
          </div>

          {/* 参考输入：图片(后台转风格描述) / txt·md 文件(并入提示词) */}
          <ReferencePanel onToast={showToast} />

          {/* 结构化 Prompt 构建器（默认折叠） */}
          <PromptBuilder onApply={(p) => setDraft(p)} />

          {/* 参数 */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <span className="w-8 text-[11px] text-ink-dim flex-shrink-0">模型</span>
              <select
                value={imageProviderId && imageModel ? `${imageProviderId}|${imageModel}` : ''}
                onChange={(e) => {
                  const i = e.target.value.indexOf('|')
                  if (i < 0) return
                  setImageSel(
                    e.target.value.slice(0, i),
                    e.target.value.slice(i + 1),
                  )
                }}
                disabled={imageModels.length === 0}
                className={selCls + ' flex-1 min-w-0'}
                title="图像模型"
              >
                {imageModels.length === 0 && <option value="">无可用图像模型</option>}
                {modelGroups.map((g) => (
                  <optgroup key={g.providerId} label={g.providerLabel}>
                    {g.items.map((m) => (
                      <option key={m.modelId} value={`${m.providerId}|${m.modelId}`}>
                        {m.modelId}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 flex-1 min-w-0">
                <span className="w-8 text-[11px] text-ink-dim flex-shrink-0">尺寸</span>
                <select
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  className={selCls + ' flex-1 min-w-0'}
                  title="尺寸"
                >
                  {IMAGE_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-[11px] text-ink-dim flex-shrink-0">数量</span>
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className={selCls}
                  title="生成数量"
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* 生成按钮 */}
          <button
            onClick={() => void handleGenerate()}
            disabled={!canGenerate}
            className="w-full py-2 rounded-lg text-sm font-medium bg-grad-primary text-white shadow-glow-primary hover:-translate-y-px disabled:opacity-40 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all"
          >
            {assembling ? '整理参考中…' : '生成图像'}
          </button>
          <p className="text-[11px] text-ink-dim leading-relaxed">
            图像由 AI 生成，可能与描述存在差异。
          </p>

          {noProviders && (
            <div className="rounded-card border border-line bg-surface px-4 py-4">
              <p className="text-sm text-ink font-medium mb-1">还没有配置模型服务</p>
              <p className="text-xs text-ink-muted leading-relaxed">
                添加一个 OpenAI 兼容服务商（Base URL + API
                Key）后，这里就能用图像模型开始创作。请到「设置」页完成配置。
              </p>
            </div>
          )}
        </div>
      </aside>

      {/* ── 右：画廊 + 筛选 ── */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <FilterBar
          models={galleryModels}
          model={filterModel}
          onModel={setFilterModel}
          range={range}
          onRange={setRange}
          keyword={keyword}
          onKeyword={setKeyword}
          favOnly={favOnly}
          onFavOnly={setFavOnly}
          shown={filtered.length}
          total={media.length}
          hasActive={hasActiveFilter}
          onClear={clearFilters}
        />

        {!mediaLoaded ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-ink-dim">加载中…</p>
          </div>
        ) : media.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-6">
            <Mascot mood="idle" size={92} className="mb-4" />
            <h2 className="text-2xl font-bold text-gradient mb-1">开始生成图像</h2>
            <p className="text-sm text-ink-dim mb-8">
              在左侧输入描述，或从示例开始，生成结果会出现在这里
            </p>
            <div className="grid grid-cols-1 gap-3 w-full max-w-xl">
              {EXAMPLE_IMAGE_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setDraft(p)
                    draftRef.current?.focus()
                  }}
                  className="text-left px-4 py-3 rounded-card glass hover:-translate-y-0.5 hover:border-line-strong text-sm text-ink-muted leading-relaxed transition-all duration-150"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
            <p className="text-sm text-ink-dim">没有匹配当前筛选条件的生成记录</p>
            <button
              onClick={clearFilters}
              className="px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-line text-ink-muted hover:bg-elevated hover:text-ink transition-colors"
            >
              清除筛选
            </button>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {filtered.map((row) => (
                <MediaCard
                  key={row.id}
                  row={row}
                  fav={favSet.has(row.id)}
                  onOpen={() => openLightbox(row)}
                  onEdit={() => openAnnotator(row.id)}
                  onDownload={() => void downloadMedia(row, showToast)}
                  onDelete={() =>
                    row.status === 'done' ? setConfirmDelete(row) : doDelete(row.id)
                  }
                  onCopyPrompt={() => void copyPrompt(row)}
                  onRetry={() => handleRetry(row)}
                  onToggleFav={() => toggleFavorite(row.id)}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 灯箱 */}
      {lightboxIdx != null && doneItems[lightboxIdx] && (
        <Lightbox
          items={doneItems}
          index={lightboxIdx}
          fav={favSet.has(doneItems[lightboxIdx].id)}
          onIndex={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onEdit={(row) => {
            setLightboxIdx(null)
            openAnnotator(row.id)
          }}
          onDownload={(row) => void downloadMedia(row, showToast)}
          onDelete={(row) => setConfirmDelete(row)}
          onToggleFav={(row) => toggleFavorite(row.id)}
        />
      )}

      {/* 再加工（标注）工作台：状态在 imageStore，跨导航保留 */}
      {annotator && annotatorRow && <AnnotatorModal row={annotatorRow} />}

      {/* 删除确认 */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface border border-line rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-ink mb-1 font-medium">删除该图片？</p>
            <p className="text-xs text-ink-muted mb-4 truncate">{confirmDelete.prompt}</p>
            <p className="text-xs text-ink-dim mb-4">此操作会永久删除本地文件，无法撤销。</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-elevated text-ink-muted border border-line transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  doDelete(confirmDelete.id)
                  setConfirmDelete(null)
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#d0342c] hover:bg-failed text-white border border-failed transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg bg-surface-2 border border-line text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
