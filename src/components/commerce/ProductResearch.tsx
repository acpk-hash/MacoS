// 模块① 选品分析（AI 分析辅助）：类目/竞品信息 → 五维评分 + Go/No-Go 记分卡报告。
import { useCommerceStore, type CommerceProject } from '../../stores/commerceStore'
import { buildResearchPrompt } from './prompts'
import MarkdownLite from '../ui/MarkdownLite'
import {
  Field,
  SectionCard,
  inputCls,
  btnPrimaryCls,
  btnGhostCls,
  downloadText,
  copyText,
  stripFence,
} from './ui'

export default function ProductResearch({ project }: { project: CommerceProject }) {
  const { patchProject, runSlot, stopSlot, slots } = useCommerceStore()
  const slot = slots.research
  const r = project.research
  const running = slot.status === 'running'

  const setResearch = (patch: Partial<typeof r>) =>
    patchProject(project.id, (p) => ({ research: { ...p.research, ...patch } }))

  const run = () => {
    if (!r.category.trim()) return
    void runSlot(
      'research',
      '选品分析：' + project.name,
      buildResearchPrompt({
        category: r.category,
        competitorNotes: r.competitorNotes,
        extraNotes: r.extraNotes,
      }),
      (p, text) => ({ research: { ...p.research, report: stripFence(text) } }),
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-dim leading-relaxed rounded-lg border border-line bg-surface-2 px-3 py-2">
        本模块为 <b className="text-ink-muted">AI 推理辅助</b>
        ，不含实时市场数据；模型未获得的数字均为推断并在报告中标注。后续可在设置接入自有数据源（预留）。
      </p>

      <SectionCard title="输入" badge="ai">
        <Field label="类目 / 产品思路" hint="必填">
          <textarea
            rows={3}
            value={r.category}
            onChange={(e) => setResearch({ category: e.target.value })}
            placeholder="例：北美市场的宠物智能喂食器；或粘贴一个候选产品的具体想法"
            className={inputCls + ' resize-y leading-relaxed'}
          />
        </Field>
        <Field label="竞品信息（可选）" hint="粘贴竞品列表、价格、评分、截图里的文字等">
          <textarea
            rows={4}
            value={r.competitorNotes}
            onChange={(e) => setResearch({ competitorNotes: e.target.value })}
            placeholder="例：Brand A $39.99 4.3星 1.2万评论；Brand B $59.99 4.6星 3千评论……"
            className={inputCls + ' resize-y leading-relaxed'}
          />
        </Field>
        <Field label="补充信息（可选）" hint="预算、供应链资源、目标毛利等约束">
          <textarea
            rows={2}
            value={r.extraNotes}
            onChange={(e) => setResearch({ extraNotes: e.target.value })}
            className={inputCls + ' resize-y leading-relaxed'}
          />
        </Field>
        <div className="flex items-center gap-2">
          <button
            onClick={run}
            disabled={running || !r.category.trim()}
            className={btnPrimaryCls}
          >
            {running ? '分析中…' : '生成选品报告'}
          </button>
          {running && (
            <button onClick={() => void stopSlot('research')} className={btnGhostCls}>
              停止
            </button>
          )}
          {slot.status === 'error' && (
            <span className="text-xs text-failed truncate">{slot.error}</span>
          )}
        </div>
      </SectionCard>

      {(running || r.report) && (
        <SectionCard
          title="选品报告（五维评分 + Go/No-Go 记分卡）"
          badge="ai"
          actions={
            r.report && !running ? (
              <>
                <button
                  onClick={() => void copyText(r.report)}
                  className={btnGhostCls}
                >
                  复制
                </button>
                <button
                  onClick={() =>
                    downloadText('选品报告-' + project.name + '.md', r.report)
                  }
                  className={btnGhostCls}
                >
                  导出 .md
                </button>
              </>
            ) : undefined
          }
        >
          <div className="max-h-[520px] overflow-y-auto pr-1">
            <MarkdownLite text={running ? slot.streamText || '正在思考…' : r.report} />
          </div>
        </SectionCard>
      )}
    </div>
  )
}
