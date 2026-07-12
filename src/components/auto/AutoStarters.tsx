// 空态工作流模板卡（借鉴 open-science WorkflowStarters 的竖排卡列表）：
// 无历史且未运行时展示，点卡把模板填进研究方向输入。
import { useAutoStore } from '../../stores/autoStore'
import { IconBook, IconBulb, IconChevronRight, IconFlask } from './icons'

interface Starter {
  id: string
  icon: React.ReactNode
  title: string
  description: string
  /** 填入研究方向输入的模板（含 <占位>，用户自行替换）。 */
  prompt: string
}

const STARTERS: Starter[] = [
  {
    id: 'survey',
    icon: <IconBook size={16} />,
    title: '综述一个方向',
    description: '系统梳理近年代表工作、方法谱系与开放问题，产出带引用的综述',
    prompt:
      '对「<替换为你的研究方向>」做一次系统性文献综述：梳理近五年的代表性工作、方法谱系与主要流派、关键数据集与评测基准，指出尚未解决的开放问题，最终产出一篇带引用的综述报告。',
  },
  {
    id: 'reproduce',
    icon: <IconFlask size={16} />,
    title: '复现 + 改进一篇论文',
    description: '搭最小可复现实验、对比原文指标，并提出可验证的改进',
    prompt:
      '复现论文《<替换为论文标题/arXiv 编号>》的核心实验：先调研该论文的方法与实验设置，搭建最小可复现实验并与原文指标对比，然后提出并验证至少一项改进方案，输出完整的实验报告。',
  },
  {
    id: 'idea',
    icon: <IconBulb size={16} />,
    title: '从 idea 到实验报告',
    description: '从一句话想法出发：调研 → 设计实验 → 运行 → 撰写论文稿',
    prompt:
      '围绕这个想法完成从选题到论文的全流程：「<用一两句话描述你的 idea>」。先调研相关工作确认新颖性，再设计并运行验证实验，最后撰写一篇结构完整的论文稿（含摘要、方法、实验与结论）。',
  },
]

export default function AutoStarters() {
  const setTopic = useAutoStore((s) => s.setTopic)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-8">
      <div className="w-full max-w-[460px] px-4">
        <div className="text-center">
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
            open-science 流水线
          </div>
          <h2 className="mt-2 text-lg font-bold text-ink">开始一次自动科研</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            填写研究方向后点「开始研究」，research agent 会自动走完
            探索→文献综述→实验评审→论文撰写→终审；或先从模板起步：
          </p>
        </div>

        <div className="mt-5 overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {STARTERS.map((s) => (
            <button
              key={s.id}
              onClick={() => setTopic(s.prompt)}
              className="group flex w-full items-center gap-3 border-t border-line px-4 py-3 text-left transition-colors first:border-t-0 hover:bg-surface-2"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-primary ring-1 ring-line transition-colors group-hover:bg-surface">
                {s.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">{s.title}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                  {s.description}
                </span>
              </span>
              <IconChevronRight
                size={14}
                className="shrink-0 text-ink-faint transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink-dim"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
