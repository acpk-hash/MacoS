import { useState } from 'react'

interface Skill {
  id: number
  name: string
  desc: string
  category: string
  downloads: number
  rating: number
}

const CATEGORIES = ['全部', '编码', '写作', '分析', '翻译', '效率']

const MOCK_SKILLS: Skill[] = [
  { id: 1, name: '代码审查', desc: '自动分析代码质量并给出改进建议', category: '编码', downloads: 12400, rating: 4.8 },
  { id: 2, name: '周报生成器', desc: '基于 Git 提交记录自动生成工作周报', category: '写作', downloads: 8900, rating: 4.6 },
  { id: 3, name: '数据可视化', desc: '将 CSV / JSON 数据快速转换为图表', category: '分析', downloads: 7200, rating: 4.5 },
  { id: 4, name: '中英互译', desc: '高质量中英文双向翻译，保留专业术语', category: '翻译', downloads: 15600, rating: 4.9 },
  { id: 5, name: 'SQL 助手', desc: '自然语言转 SQL 查询，支持多种数据库', category: '编码', downloads: 9800, rating: 4.7 },
  { id: 6, name: '会议纪要', desc: '录音或文字整理为结构化会议纪要', category: '效率', downloads: 6300, rating: 4.4 },
  { id: 7, name: 'API 文档', desc: '根据代码自动生成 RESTful API 文档', category: '编码', downloads: 5100, rating: 4.3 },
  { id: 8, name: '论文摘要', desc: '提取学术论文核心观点与研究方法', category: '分析', downloads: 4200, rating: 4.5 },
  { id: 9, name: '邮件润色', desc: '优化邮件措辞，适配正式 / 友好语气', category: '写作', downloads: 3800, rating: 4.2 },
  { id: 10, name: '日程规划', desc: '智能安排日程，自动识别优先级', category: '效率', downloads: 7600, rating: 4.6 },
]

function formatDownloads(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const categoryBadge: Record<string, string> = {
  '编码': 'badge-sky',
  '写作': 'badge-mint',
  '分析': 'badge-gold',
  '翻译': 'badge-coral',
  '效率': 'badge-mint',
}

export default function Skills() {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')

  const filtered = MOCK_SKILLS.filter((s) => {
    const matchCategory = activeCategory === '全部' || s.category === activeCategory
    const matchSearch = !search || s.name.includes(search) || s.desc.includes(search)
    return matchCategory && matchSearch
  })

  return (
    <div className="page">
      <div className="page-header">
        <h1>{'Skills 市场'}</h1>
      </div>
      <div className="page-body flex flex-col gap-3">
        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索技能…"
          className="input"
        />

        {/* Category pills */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setActiveCategory(c)}
              className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                activeCategory === c
                  ? 'bg-primary text-white'
                  : 'bg-surface-2 text-ink-muted'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Skill list */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint animate-in">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <p className="text-sm">{'未找到匹配的技能'}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((skill) => (
              <div key={skill.id} className="card animate-in">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-lg shrink-0">
                    {'\u{1F9E9}'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-ink truncate">{skill.name}</p>
                      <span className={`badge ${categoryBadge[skill.category] ?? 'badge-sky'}`}>{skill.category}</span>
                    </div>
                    <p className="text-xs text-ink-muted mt-1 line-clamp-2">{skill.desc}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-[11px] text-ink-dim">{'⭐'} {skill.rating}</span>
                      <span className="text-[11px] text-ink-dim">{'⬇'} {formatDownloads(skill.downloads)}</span>
                    </div>
                  </div>
                  <button onClick={() => alert('功能开发中')} className="btn btn-sm btn-primary shrink-0 self-center">
                    {'安装'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
