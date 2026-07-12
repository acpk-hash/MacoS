// 模块③ 评论 & 搜索词洞察：
//  A. 搜索词报告 CSV（用户真实数据）→ 自写解析 + 本地决策规则引擎（硬计算）
//     → 可选让模型出洞察摘要（AI 辅助）。
//  B. 评论粘贴 → 六维痛点分析提示词 → 报告（AI 辅助）。
import { useRef, useState, type ChangeEvent } from 'react'
import {
  useCommerceStore,
  TERM_ACTION_LABEL,
  type CommerceProject,
  type TermAction,
} from '../../stores/commerceStore'
import { buildReviewPrompt, buildTermSummaryPrompt } from './prompts'
import MarkdownLite from '../ui/MarkdownLite'
import {
  Field,
  SectionCard,
  TrustBadge,
  inputCls,
  btnPrimaryCls,
  btnGhostCls,
  downloadText,
  copyText,
  stripFence,
} from './ui'

const ACTION_CLS: Record<TermAction, string> = {
  negative_candidate: 'bg-failed/10 text-failed border-failed/30',
  scale_up: 'bg-mint/10 text-mint border-mint/30',
  reduce_bid: 'bg-gold/10 text-[#b8860b] border-gold/40',
  hold_test: 'bg-sky/10 text-sky border-sky/30',
  observe: 'bg-surface-2 text-ink-dim border-line',
}

const CONF_LABEL = { high: '高', medium: '中', low: '低' } as const

export default function InsightLab({ project }: { project: CommerceProject }) {
  const { patchProject, loadTermsCsv, runSlot, stopSlot, slots } = useCommerceStore()
  const ins = project.insight
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [filterAction, setFilterAction] = useState<TermAction | ''>('')
  const [csvError, setCsvError] = useState<string | null>(null)

  const insightSlot = slots.insight
  const reviewSlot = slots.review

  const onCsvPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 8 * 1024 * 1024) {
      setCsvError('文件超过 8MB，请先在本地筛选时间窗后再导出')
      return
    }
    setCsvError(null)
    try {
      const text = await file.text()
      loadTermsCsv(file.name, text)
    } catch (err) {
      setCsvError('读取失败：' + String(err))
    }
  }

  const decisions = ins.decisions
  const shown = filterAction ? decisions.filter((d) => d.action === filterAction) : decisions
  const totals = decisions.reduce(
    (a, d) => ({
      clicks: a.clicks + d.clicks,
      spend: a.spend + d.spend,
      orders: a.orders + d.orders,
      impressions: a.impressions + d.impressions,
    }),
    { clicks: 0, spend: 0, orders: 0, impressions: 0 },
  )
  const actionCounts = decisions.reduce(
    (m, d) => {
      m[d.action] = (m[d.action] ?? 0) + 1
      return m
    },
    {} as Record<TermAction, number>,
  )

  const runSummary = () => {
    if (decisions.length === 0) return
    const brief = decisions
      .slice(0, 60)
      .map(
        (d) =>
          '`' + d.term + '` 点击' + d.clicks + ' 花费$' + d.spend.toFixed(2) + ' 订单' + d.orders +
          (d.cvr != null ? ' CVR ' + (d.cvr * 100).toFixed(1) + '%' : '') +
          (d.acos != null ? ' ACOS ' + (d.acos * 100).toFixed(0) + '%' : '') +
          ' → ' + TERM_ACTION_LABEL[d.action] + '（' + d.reason + '）',
      )
      .join('\n')
    void runSlot(
      'insight',
      '搜索词洞察：' + project.name,
      buildTermSummaryPrompt({
        fileName: ins.csvFileName,
        baselineCvr: ins.baselineCvr,
        totalRow:
          '合计：曝光 ' + totals.impressions + '、点击 ' + totals.clicks +
          '、花费 $' + totals.spend.toFixed(2) + '、订单 ' + totals.orders + '。',
        decisionsBrief: brief,
      }),
      (p, text) => ({ insight: { ...p.insight, aiSummary: stripFence(text) } }),
    )
  }

  const runReview = () => {
    if (!ins.reviewText.trim()) return
    void runSlot(
      'review',
      '评论痛点分析：' + project.name,
      buildReviewPrompt(ins.reviewText, p0(project)),
      (p, text) => ({ insight: { ...p.insight, reviewReport: stripFence(text) } }),
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── A. 搜索词报告 ── */}
      <SectionCard
        title="搜索词报告分析"
        badge="user"
        actions={<TrustBadge kind="local" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void onCsvPick(e)}
          />
          <button onClick={() => fileRef.current?.click()} className={btnPrimaryCls}>
            上传搜索词报告 CSV
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            目标 ACOS %
            <input
              type="number"
              min="1"
              max="100"
              value={ins.targetAcosPct}
              onChange={(e) =>
                patchProject(project.id, (p) => ({
                  insight: { ...p.insight, targetAcosPct: Number(e.target.value) || 30 },
                }))
              }
              className={inputCls + ' w-20 py-1 text-xs'}
            />
          </label>
          {ins.csvFileName && (
            <span className="text-xs text-ink-muted truncate">
              已加载：{ins.csvFileName}（{decisions.length} 个词）
            </span>
          )}
        </div>
        <p className="text-[11px] text-ink-faint leading-relaxed">
          支持亚马逊卖家后台 SP/SB/SD 搜索词报告（中英文表头）。解析与决策规则全部本地执行，
          数据不出本机；修改目标 ACOS 后重新上传即按新阈值判定。
        </p>
        {(csvError || ins.analysisNote) && (
          <p className="text-xs text-failed">{csvError ?? ins.analysisNote}</p>
        )}
      </SectionCard>

      {decisions.length > 0 && (
        <SectionCard title="汇总与决策建议" badge="local">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              { label: '曝光', value: totals.impressions.toLocaleString() },
              { label: '点击', value: totals.clicks.toLocaleString() },
              { label: '花费', value: '$' + totals.spend.toFixed(2) },
              { label: '订单', value: String(totals.orders) },
              {
                label: '基准 CVR',
                value: ins.baselineCvr != null ? (ins.baselineCvr * 100).toFixed(2) + '%' : '—',
              },
            ].map((c, i) => (
              <div key={i} className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                <p className="text-[10.5px] text-ink-dim">{c.label}</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{c.value}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setFilterAction('')}
              className={
                'px-2 py-1 rounded-full border text-[11px] transition-colors ' +
                (filterAction === '' ? 'bg-accent text-white border-accent' : 'bg-surface-2 text-ink-muted border-line')
              }
            >
              全部 {decisions.length}
            </button>
            {(Object.keys(TERM_ACTION_LABEL) as TermAction[]).map((a) =>
              actionCounts[a] ? (
                <button
                  key={a}
                  onClick={() => setFilterAction(filterAction === a ? '' : a)}
                  className={
                    'px-2 py-1 rounded-full border text-[11px] transition-colors ' +
                    (filterAction === a ? 'ring-1 ring-accent ' : '') +
                    ACTION_CLS[a]
                  }
                >
                  {TERM_ACTION_LABEL[a]} {actionCounts[a]}
                </button>
              ) : null,
            )}
          </div>

          <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-line rounded-lg">
            <table className="text-xs border-collapse min-w-full">
              <thead className="sticky top-0">
                <tr>
                  {['搜索词', '曝光', '点击', '花费', '订单', 'CVR', 'ACOS', '建议', '置信', '理由'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-line bg-surface-2 px-2 py-1.5 text-left font-medium text-ink-muted whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 200).map((d) => (
                  <tr key={d.term} className="odd:bg-surface even:bg-surface-2/40 align-top">
                    <td className="px-2 py-1.5 text-ink max-w-[220px] break-words">{d.term}</td>
                    <td className="px-2 py-1.5 tabular-nums">{d.impressions}</td>
                    <td className="px-2 py-1.5 tabular-nums">{d.clicks}</td>
                    <td className="px-2 py-1.5 tabular-nums">${d.spend.toFixed(2)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{d.orders}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {d.cvr != null ? (d.cvr * 100).toFixed(1) + '%' : '—'}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {d.acos != null ? (d.acos * 100).toFixed(0) + '%' : '—'}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className={'px-1.5 py-0.5 rounded border text-[10.5px] ' + ACTION_CLS[d.action]}>
                        {TERM_ACTION_LABEL[d.action]}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">{CONF_LABEL[d.confidence]}</td>
                    <td className="px-2 py-1.5 text-ink-muted max-w-[320px] break-words">{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > 200 && (
              <p className="px-2 py-1.5 text-[11px] text-ink-faint">
                仅展示前 200 行（当前筛选共 {shown.length} 行），可用上方标签缩小范围。
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={runSummary}
              disabled={insightSlot.status === 'running'}
              className={btnGhostCls}
            >
              {insightSlot.status === 'running' ? '生成摘要中…' : '让模型出洞察摘要（AI 辅助，可选）'}
            </button>
            {insightSlot.status === 'running' && (
              <button onClick={() => void stopSlot('insight')} className={btnGhostCls}>
                停止
              </button>
            )}
            {insightSlot.status === 'error' && (
              <span className="text-xs text-failed truncate">{insightSlot.error}</span>
            )}
          </div>
          {(insightSlot.status === 'running' || ins.aiSummary) && (
            <div className="rounded-lg border border-line bg-surface-2/50 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <TrustBadge kind="ai" />
                {ins.aiSummary && insightSlot.status !== 'running' && (
                  <button
                    onClick={() => void copyText(ins.aiSummary)}
                    className="ml-auto text-[11px] text-ink-dim hover:text-ink"
                  >
                    复制
                  </button>
                )}
              </div>
              <MarkdownLite
                text={
                  insightSlot.status === 'running'
                    ? insightSlot.streamText || '正在阅读决策表…'
                    : ins.aiSummary
                }
              />
            </div>
          )}
        </SectionCard>
      )}

      {/* ── B. 评论痛点分析 ── */}
      <SectionCard title="评论痛点分析（六维）" badge="user" actions={<TrustBadge kind="ai" />}>
        <Field label="粘贴买家评论" hint="一行一条或整段粘贴均可；建议 10~200 条">
          <textarea
            rows={6}
            value={ins.reviewText}
            onChange={(e) =>
              patchProject(project.id, (p) => ({
                insight: { ...p.insight, reviewText: e.target.value },
              }))
            }
            placeholder="把亚马逊/独立站的买家评论（含差评）粘贴到这里…"
            className={inputCls + ' resize-y leading-relaxed'}
          />
        </Field>
        <div className="flex items-center gap-2">
          <button
            onClick={runReview}
            disabled={reviewSlot.status === 'running' || !ins.reviewText.trim()}
            className={btnPrimaryCls}
          >
            {reviewSlot.status === 'running' ? '分析中…' : '生成六维痛点报告'}
          </button>
          {reviewSlot.status === 'running' && (
            <button onClick={() => void stopSlot('review')} className={btnGhostCls}>
              停止
            </button>
          )}
          {reviewSlot.status === 'error' && (
            <span className="text-xs text-failed truncate">{reviewSlot.error}</span>
          )}
        </div>
        {(reviewSlot.status === 'running' || ins.reviewReport) && (
          <div className="rounded-lg border border-line bg-surface-2/50 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <TrustBadge kind="ai" />
              {ins.reviewReport && reviewSlot.status !== 'running' && (
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => void copyText(ins.reviewReport)}
                    className="text-[11px] text-ink-dim hover:text-ink"
                  >
                    复制
                  </button>
                  <button
                    onClick={() =>
                      downloadText('评论痛点报告-' + project.name + '.md', ins.reviewReport)
                    }
                    className="text-[11px] text-ink-dim hover:text-ink"
                  >
                    导出 .md
                  </button>
                </div>
              )}
            </div>
            <div className="max-h-[480px] overflow-y-auto pr-1">
              <MarkdownLite
                text={
                  reviewSlot.status === 'running'
                    ? reviewSlot.streamText || '正在归类痛点…'
                    : ins.reviewReport
                }
              />
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

/** 评论分析的产品背景提示：优先用模块①填写的类目/产品思路。 */
function p0(project: CommerceProject): string {
  return project.research.category
}
