// 模块④ 产品图生成（核心卖点，走自有 image_generate 通道）：
// 选图型（8 分类）→ 选场景模板（25 内置）→ 填变量槽 → 合成 prompt 预览
// → 批量生成 → 项目画廊（与图像板块共用 gen_media 记录，可跳转再加工）。
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useCommerceStore, type CommerceProject } from '../../stores/commerceStore'
import { useStudioStore } from '../../stores/studioStore'
import {
  IMAGE_TYPES,
  SCENARIO_TEMPLATES,
  SLOT_DEFS,
  buildScenarioPrompt,
  type SlotKey,
} from './imageTemplates'
import { Field, SectionCard, inputCls, selectCls, btnPrimaryCls, btnGhostCls } from './ui'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto']

export default function ImageFactory({ project }: { project: CommerceProject }) {
  const {
    aggModels,
    imageModel,
    imageProviderId,
    setImageModelSel,
    patchProject,
    imagesGenerating,
    imagesProgress,
    generateImages,
  } = useCommerceStore()
  const { media, loadMedia } = useStudioStore()
  const navigate = useNavigate()
  const [showPreview, setShowPreview] = useState(false)

  const w = project.images
  const imageModels = useMemo(() => aggModels.filter((m) => m.kind === 'image'), [aggModels])

  useEffect(() => {
    if (isTauri) void loadMedia('image')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setImages = (patch: Partial<typeof w>) =>
    patchProject(project.id, (p) => ({ images: { ...p.images, ...patch } }))

  const visibleTemplates = useMemo(
    () => (w.typeId ? SCENARIO_TEMPLATES.filter((t) => t.typeId === w.typeId) : SCENARIO_TEMPLATES),
    [w.typeId],
  )

  const selected = useMemo(
    () => SCENARIO_TEMPLATES.filter((t) => w.templateIds.includes(t.id)),
    [w.templateIds],
  )

  /** 已选模板用到的变量槽并集（product 恒在最前）。 */
  const usedSlots = useMemo(() => {
    const set = new Set<SlotKey>(['product'])
    for (const t of selected) for (const u of t.uses) set.add(u)
    return (Object.keys(SLOT_DEFS) as SlotKey[]).filter((k) => set.has(k))
  }, [selected])

  const toggleTemplate = (id: string) =>
    setImages({
      templateIds: w.templateIds.includes(id)
        ? w.templateIds.filter((x) => x !== id)
        : [...w.templateIds, id],
    })

  const canGenerate =
    selected.length > 0 && (w.vars.product ?? '').trim() !== '' && !!imageModel && !imagesGenerating

  const jobs = useMemo(
    () =>
      selected.map((t) => ({
        name: t.name,
        prompt: buildScenarioPrompt(t, w.vars),
      })),
    [selected, w.vars],
  )

  const galleryRows = useMemo(() => {
    const idSet = new Set(w.mediaIds)
    return media.filter((m) => idSet.has(m.id))
  }, [media, w.mediaIds])

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-dim leading-relaxed rounded-lg border border-line bg-surface-2 px-3 py-2">
        内置 8 图型 × 25 场景模板（自研提示词库）；生成走本应用的图像通道，
        结果与「图像」板块共用画廊记录，可跳过去做标注再加工。
      </p>

      <SectionCard title="① 选图型" badge="ai">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setImages({ typeId: '' })}
            className={
              'px-2.5 py-1.5 rounded-lg border text-xs transition-colors ' +
              (w.typeId === ''
                ? 'bg-accent text-white border-accent'
                : 'bg-surface-2 text-ink-muted border-line hover:text-ink')
            }
          >
            全部
          </button>
          {IMAGE_TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setImages({ typeId: w.typeId === t.id ? '' : t.id })}
              title={t.role}
              className={
                'px-2.5 py-1.5 rounded-lg border text-xs transition-colors ' +
                (w.typeId === t.id
                  ? 'bg-accent text-white border-accent'
                  : 'bg-surface-2 text-ink-muted border-line hover:text-ink')
              }
            >
              {t.name}
            </button>
          ))}
        </div>
        {w.typeId && (
          <p className="text-[11px] text-ink-faint">
            {IMAGE_TYPES.find((t) => t.id === w.typeId)?.role}
          </p>
        )}
      </SectionCard>

      <SectionCard title={'② 选场景模板（可多选，已选 ' + selected.length + '）'} badge="ai">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {visibleTemplates.map((t) => {
            const on = w.templateIds.includes(t.id)
            return (
              <button
                key={t.id}
                onClick={() => toggleTemplate(t.id)}
                className={
                  'text-left rounded-lg border px-3 py-2.5 transition-colors ' +
                  (on
                    ? 'border-accent bg-accent-soft'
                    : 'border-line bg-surface-2 hover:border-line-strong')
                }
              >
                <p className="text-xs font-medium text-ink flex items-center gap-1.5">
                  <span
                    className={
                      'inline-block w-3.5 h-3.5 rounded border text-[9px] leading-[13px] text-center ' +
                      (on ? 'bg-accent text-white border-accent' : 'border-line-strong text-transparent')
                    }
                  >
                    ✓
                  </span>
                  {t.name}
                </p>
                <p className="mt-1 text-[10.5px] text-ink-dim leading-snug">{t.categories}</p>
                {t.antiAiTips && (
                  <p className="mt-1 text-[10.5px] text-[#b8860b] leading-snug">
                    反AI味：{t.antiAiTips}
                  </p>
                )}
              </button>
            )
          })}
        </div>
      </SectionCard>

      <SectionCard title="③ 填变量 → 合成与生成" badge="ai">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {usedSlots.map((k) => (
            <Field key={k} label={SLOT_DEFS[k].label} hint={SLOT_DEFS[k].required ? '必填' : undefined}>
              <input
                value={w.vars[k] ?? ''}
                onChange={(e) => setImages({ vars: { ...w.vars, [k]: e.target.value } })}
                placeholder={SLOT_DEFS[k].placeholder}
                className={inputCls}
              />
            </Field>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            模型
            <select
              value={imageProviderId && imageModel ? imageProviderId + '|' + imageModel : ''}
              onChange={(e) => {
                const i = e.target.value.indexOf('|')
                if (i < 0) return
                setImageModelSel(e.target.value.slice(0, i), e.target.value.slice(i + 1))
              }}
              disabled={imageModels.length === 0}
              className={selectCls}
            >
              {imageModels.length === 0 && <option value="">无可用图像模型</option>}
              {imageModels.map((m) => (
                <option key={m.providerId + '|' + m.modelId} value={m.providerId + '|' + m.modelId}>
                  {m.modelId}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            尺寸
            <select
              value={w.size}
              onChange={(e) => setImages({ size: e.target.value })}
              className={selectCls}
            >
              {IMAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setShowPreview((v) => !v)}
            disabled={selected.length === 0}
            className={btnGhostCls}
          >
            {showPreview ? '收起 prompt 预览' : '预览合成 prompt'}
          </button>
          <button
            onClick={() => void generateImages(jobs, w.size)}
            disabled={!canGenerate}
            className={btnPrimaryCls}
          >
            {imagesGenerating ? '生成中…' : '批量生成 ' + (selected.length || '') + ' 张'}
          </button>
        </div>

        {imagesGenerating && imagesProgress && (
          <p className="text-xs text-sky">{imagesProgress}</p>
        )}
        {!imagesGenerating && imagesProgress && (
          <p className="text-xs text-failed">{imagesProgress}</p>
        )}

        {showPreview && selected.length > 0 && (
          <div className="flex flex-col gap-2">
            {jobs.map((j) => (
              <div key={j.name} className="rounded-lg border border-line bg-surface-2 p-2.5">
                <p className="text-[11px] font-medium text-ink-muted mb-1">{j.name}</p>
                <p className="text-[11px] text-ink-dim leading-relaxed break-words font-mono">
                  {j.prompt}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={'项目画廊（' + galleryRows.length + '）'}
        badge="ai"
        actions={
          <button onClick={() => navigate('/image')} className={btnGhostCls}>
            去图像板块再加工 →
          </button>
        }
      >
        {galleryRows.length === 0 ? (
          <p className="text-xs text-ink-dim">
            本项目还没有生成记录。选好模板、填好产品描述后点「批量生成」。
          </p>
        ) : (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {galleryRows.map((row) => (
              <div
                key={row.id}
                className="rounded-lg border border-line overflow-hidden bg-surface-2 flex flex-col"
              >
                <div className="aspect-square flex items-center justify-center overflow-hidden">
                  {row.status === 'done' && row.local_path ? (
                    <img
                      src={convertFileSrc(row.local_path)}
                      alt={row.prompt.slice(0, 40)}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : row.status === 'failed' ? (
                    <span className="text-xs text-failed px-3 text-center">
                      失败：{row.error ?? '未知错误'}
                    </span>
                  ) : (
                    <span className="inline-block w-6 h-6 rounded-full border-2 border-line border-t-sky animate-spin" />
                  )}
                </div>
                <p className="px-2 py-1.5 text-[10.5px] text-ink-dim truncate" title={row.prompt}>
                  {row.prompt}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}
