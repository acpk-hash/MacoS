// 模块⑤ Listing 构建器（AI 分析辅助）：产品信息 + ①③④产出一键引用
// → 8 步方法论提示词 → 标题/五点/A+/搜索词 → 预览导出，可迭代改写。
import { useState } from 'react'
import { useCommerceStore, type CommerceProject } from '../../stores/commerceStore'
import { buildListingPrompt, buildListingRefinePrompt } from './prompts'
import { SCENARIO_TEMPLATES } from './imageTemplates'
import MarkdownLite from '../ui/MarkdownLite'
import {
  Field,
  SectionCard,
  inputCls,
  selectCls,
  btnPrimaryCls,
  btnGhostCls,
  downloadText,
  copyText,
  stripFence,
} from './ui'

const MARKETPLACES = ['美国站', '欧洲站（英语）', '英国站', '日本站', '其他']

/** 截取引用材料（防止 prompt 过长）。 */
function excerpt(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? t.slice(0, max) + '\n…（已截断）' : t
}

export default function ListingBuilder({ project }: { project: CommerceProject }) {
  const { patchProject, runSlot, stopSlot, slots } = useCommerceStore()
  const slot = slots.listing
  const l = project.listing
  const running = slot.status === 'running'
  const [refineText, setRefineText] = useState('')

  const setListing = (patch: Partial<typeof l>) =>
    patchProject(project.id, (p) => ({ listing: { ...p.listing, ...patch } }))

  const hasResearch = !!project.research.report
  const hasInsight = !!project.insight.reviewReport || project.insight.decisions.length > 0
  const hasImages = project.images.templateIds.length > 0 || project.images.mediaIds.length > 0

  const buildRefs = () => {
    const researchExcerpt =
      l.useResearch && hasResearch ? excerpt(project.research.report, 2500) : ''
    let insightExcerpt = ''
    if (l.useInsight && hasInsight) {
      const parts: string[] = []
      if (project.insight.reviewReport) {
        parts.push('【评论痛点报告节选】\n' + excerpt(project.insight.reviewReport, 1800))
      }
      if (project.insight.aiSummary) {
        parts.push('【搜索词洞察摘要】\n' + excerpt(project.insight.aiSummary, 1200))
      }
      const top = project.insight.decisions.slice(0, 15)
      if (top.length) {
        parts.push(
          '【搜索词决策（本地规则引擎 Top15）】\n' +
            top
              .map((d) => d.term + ' → ' + d.action + '（点击' + d.clicks + '/花费$' + d.spend.toFixed(1) + '）')
              .join('\n'),
        )
      }
      insightExcerpt = parts.join('\n\n')
    }
    let imageExcerpt = ''
    if (l.useImages && hasImages) {
      const names = SCENARIO_TEMPLATES.filter((t) => project.images.templateIds.includes(t.id))
        .map((t) => t.name)
        .join('、')
      const sp = (project.images.vars.selling_points ?? '').trim()
      imageExcerpt =
        '已规划/生成的图片方向：' + (names || '若干') +
        (sp ? '；图片主打卖点：' + sp : '')
    }
    return { researchExcerpt, insightExcerpt, imageExcerpt }
  }

  const run = () => {
    if (!l.productInfo.trim()) return
    const refs = buildRefs()
    void runSlot(
      'listing',
      'Listing 构建：' + project.name,
      buildListingPrompt({
        productInfo: l.productInfo,
        keywords: l.keywords,
        audience: l.audience,
        marketplace: l.marketplace,
        ...refs,
      }),
      (p, text) => ({ listing: { ...p.listing, output: stripFence(text) } }),
    )
  }

  const refine = () => {
    if (!refineText.trim() || !l.output) return
    void runSlot(
      'listing',
      'Listing 改写：' + project.name,
      buildListingRefinePrompt(l.output, refineText),
      (p, text) => ({ listing: { ...p.listing, output: stripFence(text) } }),
    )
    setRefineText('')
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-dim leading-relaxed rounded-lg border border-line bg-surface-2 px-3 py-2">
        向导式生成：8 步方法论（关键词分层 → 疑虑库 → 卖点证据化 → 标题 → 五点 →
        A+ → Search Terms → QA），可一键引用模块①③④的同项目产出。
      </p>

      <SectionCard title="产品信息与引用" badge="ai">
        <Field label="产品信息" hint="必填：品名、材质规格、核心卖点、差异化、品牌名等">
          <textarea
            rows={4}
            value={l.productInfo}
            onChange={(e) => setListing({ productInfo: e.target.value })}
            placeholder="例：品牌 Acme 的 12 束抗 UV 户外仿真花，PE 材质，可插花盆/花箱，三年不褪色…"
            className={inputCls + ' resize-y leading-relaxed'}
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="关键词素材（可选）" hint="已有词表/竞品词可粘贴">
            <textarea
              rows={2}
              value={l.keywords}
              onChange={(e) => setListing({ keywords: e.target.value })}
              className={inputCls + ' resize-y'}
            />
          </Field>
          <Field label="目标人群（可选）">
            <textarea
              rows={2}
              value={l.audience}
              onChange={(e) => setListing({ audience: e.target.value })}
              className={inputCls + ' resize-y'}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            站点
            <select
              value={l.marketplace}
              onChange={(e) => setListing({ marketplace: e.target.value })}
              className={selectCls}
            >
              {MARKETPLACES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {[
            { key: 'useResearch' as const, label: '引用①选品报告', has: hasResearch },
            { key: 'useInsight' as const, label: '引用③评论/搜索词洞察', has: hasInsight },
            { key: 'useImages' as const, label: '引用④出图卖点方向', has: hasImages },
          ].map((c) => (
            <label
              key={c.key}
              className={
                'flex items-center gap-1.5 text-[11px] ' +
                (c.has ? 'text-ink-muted' : 'text-ink-faint')
              }
              title={c.has ? '' : '该模块暂无产出'}
            >
              <input
                type="checkbox"
                checked={l[c.key] && c.has}
                disabled={!c.has}
                onChange={(e) => setListing({ [c.key]: e.target.checked } as Partial<typeof l>)}
              />
              {c.label}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={run} disabled={running || !l.productInfo.trim()} className={btnPrimaryCls}>
            {running ? '生成中…' : l.output ? '重新生成完整 Listing' : '生成完整 Listing'}
          </button>
          {running && (
            <button onClick={() => void stopSlot('listing')} className={btnGhostCls}>
              停止
            </button>
          )}
          {slot.status === 'error' && (
            <span className="text-xs text-failed truncate">{slot.error}</span>
          )}
        </div>
      </SectionCard>

      {(running || l.output) && (
        <SectionCard
          title="Listing 文案"
          badge="ai"
          actions={
            l.output && !running ? (
              <>
                <button onClick={() => void copyText(l.output)} className={btnGhostCls}>
                  复制
                </button>
                <button
                  onClick={() => downloadText('listing-' + project.name + '.md', l.output)}
                  className={btnGhostCls}
                >
                  导出 .md
                </button>
              </>
            ) : undefined
          }
        >
          <div className="max-h-[560px] overflow-y-auto pr-1">
            <MarkdownLite text={running ? slot.streamText || '正在推演 8 步方法论…' : l.output} />
          </div>
          {l.output && !running && (
            <div className="flex items-center gap-2 pt-1 border-t border-line">
              <input
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    refine()
                  }
                }}
                placeholder="迭代改写：如「标题再短一点，五点第 2 条换成防水卖点」"
                className={inputCls}
              />
              <button onClick={refine} disabled={!refineText.trim()} className={btnGhostCls}>
                改写
              </button>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  )
}
