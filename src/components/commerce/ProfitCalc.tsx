// 模块② 利润测算（本地硬计算，全模块唯一无 AI 参与）：
// 售价/成本/头程/FBA/佣金/退货率/广告占比 → 毛利/净利率/盈亏平衡 ACOS·ROAS。
// 公式全部在下方明示，可保存多方案对比。
import { useState } from 'react'
import {
  useCommerceStore,
  computeProfit,
  COMMISSION_PRESETS,
  DEFAULT_PROFIT_INPUT,
  type CommerceProject,
  type ProfitInput,
} from '../../stores/commerceStore'
import { Field, SectionCard, inputCls, selectCls, btnPrimaryCls } from './ui'

const FIELDS: { key: keyof ProfitInput; label: string; hint?: string }[] = [
  { key: 'price', label: '售价' },
  { key: 'cogs', label: '采购成本' },
  { key: 'freight', label: '头程运费 / 件' },
  { key: 'fbaFee', label: 'FBA 配送费 / 件' },
  { key: 'commissionPct', label: '平台佣金 %' },
  { key: 'returnRatePct', label: '退货率 %' },
  { key: 'adPct', label: '广告费占比 %', hint: 'TACOS' },
  { key: 'otherFee', label: '其他费用 / 件', hint: '仓储/包装等' },
]

function fmt(v: number): string {
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toFixed(2)
}

export default function ProfitCalc({ project }: { project: CommerceProject }) {
  const { patchProject } = useCommerceStore()
  const [scenarioName, setScenarioName] = useState('')

  const draft: ProfitInput = project.profitDraft ?? { ...DEFAULT_PROFIT_INPUT }
  const result = computeProfit(draft)

  const setDraft = (key: keyof ProfitInput, value: number) =>
    patchProject(project.id, (p) => ({
      profitDraft: { ...(p.profitDraft ?? DEFAULT_PROFIT_INPUT), [key]: value },
    }))

  const saveScenario = () => {
    const name = scenarioName.trim() || '方案 ' + (project.profitScenarios.length + 1)
    patchProject(project.id, (p) => ({
      profitScenarios: [
        ...p.profitScenarios,
        { id: 'ps-' + Math.random().toString(36).slice(2), name, input: { ...draft }, createdAt: Date.now() },
      ],
    }))
    setScenarioName('')
  }

  const deleteScenario = (id: string) =>
    patchProject(project.id, (p) => ({
      profitScenarios: p.profitScenarios.filter((s) => s.id !== id),
    }))

  const netCls = (v: number) => (v >= 0 ? 'text-mint' : 'text-failed')

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-dim leading-relaxed rounded-lg border border-line bg-surface-2 px-3 py-2">
        本模块为纯<b className="text-ink-muted">本地计算</b>
        ，不调用任何模型；公式见结果卡底部，输入即所得。
      </p>

      <SectionCard title="成本结构输入" badge="local">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                type="number"
                step="0.01"
                min="0"
                value={Number.isFinite(draft[f.key]) ? draft[f.key] : 0}
                onChange={(e) => setDraft(f.key, Number(e.target.value))}
                className={inputCls}
              />
            </Field>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-dim">佣金常见档：</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setDraft('commissionPct', Number(e.target.value))
            }}
            className={selectCls}
          >
            <option value="">选择预设…</option>
            {COMMISSION_PRESETS.map((p, i) => (
              <option key={i} value={p.pct}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </SectionCard>

      <SectionCard title="测算结果" badge="local">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: '平台佣金', value: fmt(result.commission) },
            { label: '毛利 / 件', value: fmt(result.grossProfit), cls: netCls(result.grossProfit) },
            { label: '毛利率', value: result.grossMarginPct.toFixed(1) + '%', cls: netCls(result.grossProfit) },
            { label: '广告费 / 件', value: fmt(result.adCost) },
            { label: '退货损耗 / 件', value: fmt(result.returnLoss) },
            { label: '净利 / 件', value: fmt(result.netProfit), cls: netCls(result.netProfit) },
            { label: '净利率', value: result.netMarginPct.toFixed(1) + '%', cls: netCls(result.netProfit) },
            {
              label: '盈亏平衡 ACOS / ROAS',
              value:
                result.breakevenAcosPct != null && result.breakevenRoas != null
                  ? result.breakevenAcosPct.toFixed(1) + '% / ' + result.breakevenRoas.toFixed(2)
                  : result.breakevenAcosPct != null
                    ? result.breakevenAcosPct.toFixed(1) + '% / —'
                    : '—',
            },
          ].map((c, i) => (
            <div key={i} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
              <p className="text-[10.5px] text-ink-dim">{c.label}</p>
              <p className={'mt-0.5 text-base font-semibold tabular-nums ' + (c.cls ?? 'text-ink')}>
                {c.value}
              </p>
            </div>
          ))}
        </div>
        <details className="text-[11px] text-ink-dim leading-relaxed">
          <summary className="cursor-pointer select-none text-ink-muted">计算公式（点开核对）</summary>
          <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
            <li>佣金 = 售价 × 佣金%</li>
            <li>毛利 = 售价 − 采购 − 头程 − FBA − 佣金 − 其他</li>
            <li>广告费 = 售价 × 广告占比%</li>
            <li>退货损耗 = 退货率% × (采购 + 头程 + FBA)（按退回件整件报废保守估计）</li>
            <li>净利 = 毛利 − 广告费 − 退货损耗；净利率 = 净利 ÷ 售价</li>
            <li>盈亏平衡 ACOS = (毛利 − 退货损耗) ÷ 售价；盈亏平衡 ROAS = 1 ÷ 盈亏平衡 ACOS</li>
          </ul>
        </details>
        <div className="flex items-center gap-2">
          <input
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            placeholder="方案名（如：美国站 $29.99）"
            className={inputCls + ' max-w-[240px]'}
          />
          <button onClick={saveScenario} className={btnPrimaryCls}>
            保存为方案
          </button>
        </div>
      </SectionCard>

      {project.profitScenarios.length > 0 && (
        <SectionCard title={'方案对比（' + project.profitScenarios.length + '）'} badge="local">
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse min-w-full">
              <thead>
                <tr>
                  {['方案', '售价', '毛利', '毛利率', '净利', '净利率', '平衡ACOS', '平衡ROAS', ''].map(
                    (h) => (
                      <th
                        key={h}
                        className="border border-line bg-surface-2 px-2 py-1.5 text-left font-medium text-ink-muted whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {project.profitScenarios.map((s) => {
                  const r = computeProfit(s.input)
                  return (
                    <tr key={s.id}>
                      <td className="border border-line px-2 py-1.5 text-ink">{s.name}</td>
                      <td className="border border-line px-2 py-1.5 tabular-nums">{fmt(s.input.price)}</td>
                      <td className={'border border-line px-2 py-1.5 tabular-nums ' + netCls(r.grossProfit)}>
                        {fmt(r.grossProfit)}
                      </td>
                      <td className="border border-line px-2 py-1.5 tabular-nums">
                        {r.grossMarginPct.toFixed(1)}%
                      </td>
                      <td className={'border border-line px-2 py-1.5 tabular-nums ' + netCls(r.netProfit)}>
                        {fmt(r.netProfit)}
                      </td>
                      <td className="border border-line px-2 py-1.5 tabular-nums">
                        {r.netMarginPct.toFixed(1)}%
                      </td>
                      <td className="border border-line px-2 py-1.5 tabular-nums">
                        {r.breakevenAcosPct != null ? r.breakevenAcosPct.toFixed(1) + '%' : '—'}
                      </td>
                      <td className="border border-line px-2 py-1.5 tabular-nums">
                        {r.breakevenRoas != null ? r.breakevenRoas.toFixed(2) : '—'}
                      </td>
                      <td className="border border-line px-2 py-1.5">
                        <button
                          onClick={() => deleteScenario(s.id)}
                          className="text-ink-faint hover:text-failed transition-colors"
                          title="删除方案"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  )
}
