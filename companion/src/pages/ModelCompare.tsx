import { useState } from 'react'

interface LeaderboardEntry {
  model: string
  elo: number
  winRate: string
  games: number
}

const initialLeaderboard: LeaderboardEntry[] = [
  { model: 'gpt-5.5', elo: 1285, winRate: '68%', games: 42 },
  { model: 'claude-opus', elo: 1260, winRate: '63%', games: 38 },
  { model: 'gpt-5.6', elo: 1245, winRate: '60%', games: 25 },
  { model: 'claude-sonnet', elo: 1220, winRate: '55%', games: 40 },
  { model: 'gpt-4o', elo: 1180, winRate: '45%', games: 35 },
]

const allModels = ['gpt-5.5', 'gpt-4o', 'claude-opus', 'claude-sonnet', 'gpt-5.6']

const mockResponses = {
  A: `这是一个很好的问题。从多个角度来分析：

1. 技术可行性：当前的技术栈已经足够成熟，可以支撑大规模部署。主要挑战在于延迟优化和成本控制。

2. 应用场景：在医疗、教育、金融等领域都有广阔的应用前景。特别是在辅助决策和自动化流程方面。

3. 伦理考量：需要建立完善的监管框架，确保 AI 系统的透明性和可解释性。`,

  B: `让我来详细解答这个问题。

首先，我们需要理解核心概念。AI 技术的发展经历了几个关键阶段，每个阶段都带来了质的飞跃。

在实际应用中，我建议关注以下几点：
- 数据质量是基础，决定了模型上限
- 模型选择应基于具体场景而非盲目追求最大参数
- 部署策略需要考虑延迟、成本和隐私的平衡

总的来说，合理规划和分步实施是成功的关键。`,
}

export default function ModelCompare() {
  const [prompt, setPrompt] = useState('')
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set(['gpt-5.5', 'claude-opus']))
  const [testing, setTesting] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [chosen, setChosen] = useState<'A' | 'B' | null>(null)
  const [leaderboard] = useState(initialLeaderboard)

  // Shuffled assignment for blind test
  const modelA = 'claude-opus'
  const modelB = 'gpt-5.5'

  function toggleModel(model: string) {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      if (next.has(model)) {
        if (next.size > 2) next.delete(model)
      } else {
        next.add(model)
      }
      return next
    })
  }

  function handleStart() {
    if (!prompt.trim() || selectedModels.size < 2) return
    setTesting(true)
    setRevealed(false)
    setChosen(null)

    setTimeout(() => {
      setTesting(false)
      setShowResults(true)
    }, 2000)
  }

  function handleChoose(choice: 'A' | 'B') {
    setChosen(choice)
    setRevealed(true)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>模型盲测</h1>
        <p>多模型 A/B 对比测试</p>
      </div>

      <div className="page-body">
        {/* Prompt Input */}
        <div className="card animate-in">
          <label className="text-sm font-medium text-ink block mb-2">测试提示词</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="输入用于对比测试的提示词..."
            rows={3}
            className="input w-full resize-none"
          />

          {/* Model Selector */}
          <div className="mt-3">
            <label className="text-xs font-medium text-ink-muted block mb-2">选择模型（至少 2 个）</label>
            <div className="flex flex-wrap gap-2">
              {allModels.map((m) => {
                const isSelected = selectedModels.has(m)
                return (
                  <button
                    key={m}
                    onClick={() => toggleModel(m)}
                    className={`
                      flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg
                      transition-colors border
                      ${isSelected
                        ? 'bg-primary text-white border-primary'
                        : 'bg-surface-2 text-ink-muted border-line hover:border-ink-dim'
                      }
                    `}
                  >
                    <span className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center ${
                      isSelected ? 'border-white' : 'border-ink-dim'
                    }`}>
                      {isSelected && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    {m}
                  </button>
                )
              })}
            </div>
          </div>

          <button
            onClick={handleStart}
            disabled={testing || !prompt.trim() || selectedModels.size < 2}
            className="btn btn-primary btn-block mt-4"
          >
            {testing ? '测试中...' : '开始盲测'}
          </button>
        </div>

        {/* Results */}
        {showResults && (
          <div className="card animate-in">
            <h2 className="text-sm font-semibold text-ink mb-3">对比结果</h2>

            <div className="flex flex-col gap-3">
              {/* Model A */}
              <div className={`rounded-xl border p-4 transition-colors ${
                chosen === 'A' ? 'border-done bg-done/5' : chosen === 'B' ? 'border-line-soft bg-surface' : 'border-line'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-ink-muted">
                    {revealed ? `Model A: ${modelA}` : 'Model A'}
                  </span>
                  {chosen === 'A' && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full badge-mint">
                      已选择
                    </span>
                  )}
                </div>
                <pre className="text-sm text-ink leading-relaxed whitespace-pre-wrap font-sans mb-3">
                  {mockResponses.A}
                </pre>
                {!revealed && (
                  <button onClick={() => handleChoose('A')} className="btn btn-secondary btn-sm btn-block">
                    选择此回答
                  </button>
                )}
              </div>

              {/* Model B */}
              <div className={`rounded-xl border p-4 transition-colors ${
                chosen === 'B' ? 'border-done bg-done/5' : chosen === 'A' ? 'border-line-soft bg-surface' : 'border-line'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-ink-muted">
                    {revealed ? `Model B: ${modelB}` : 'Model B'}
                  </span>
                  {chosen === 'B' && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full badge-mint">
                      已选择
                    </span>
                  )}
                </div>
                <pre className="text-sm text-ink leading-relaxed whitespace-pre-wrap font-sans mb-3">
                  {mockResponses.B}
                </pre>
                {!revealed && (
                  <button onClick={() => handleChoose('B')} className="btn btn-secondary btn-sm btn-block">
                    选择此回答
                  </button>
                )}
              </div>

              {revealed && (
                <p className="text-xs text-ink-muted text-center">
                  你选择了 <span className="font-semibold text-ink">{chosen === 'A' ? modelA : modelB}</span> 的回答，ELO 分数已更新
                </p>
              )}
            </div>
          </div>
        )}

        {/* Leaderboard */}
        <div className="card animate-in" style={{ animationDelay: '60ms' }}>
          <h2 className="text-sm font-semibold text-ink mb-3">排行榜</h2>

          {/* Table header */}
          <div className="flex items-center gap-2 px-3 py-2 text-[10px] font-bold text-ink-dim uppercase tracking-wide">
            <span className="w-6 text-center">#</span>
            <span className="flex-1">模型</span>
            <span className="w-12 text-right">ELO</span>
            <span className="w-12 text-right">胜率</span>
            <span className="w-10 text-right">场次</span>
          </div>

          <div className="flex flex-col gap-1">
            {leaderboard.map((entry, i) => (
              <div
                key={entry.model}
                className={`
                  flex items-center gap-2 px-3 py-2.5 rounded-lg
                  ${i === 0 ? 'bg-primary/5 border border-primary/10' : 'card-flat'}
                `}
              >
                <span className={`w-6 text-center text-xs font-bold ${
                  i === 0 ? 'text-primary' : 'text-ink-dim'
                }`}>
                  {i + 1}
                </span>
                <span className={`flex-1 text-sm font-medium ${
                  i === 0 ? 'text-ink' : 'text-ink-muted'
                }`}>
                  {entry.model}
                </span>
                <span className="w-12 text-right text-sm font-bold text-ink tabular-nums">
                  {entry.elo}
                </span>
                <span className="w-12 text-right text-xs text-ink-muted tabular-nums">
                  {entry.winRate}
                </span>
                <span className="w-10 text-right text-xs text-ink-dim tabular-nums">
                  {entry.games}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
