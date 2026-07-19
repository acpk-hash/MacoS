import { useState, useRef, useEffect } from 'react'

const phases = [
  { id: 1, label: '问题分析' },
  { id: 2, label: '信息收集' },
  { id: 3, label: '深度分析' },
  { id: 4, label: '交叉验证' },
  { id: 5, label: '报告生成' },
]

const mockHistory = [
  { id: 1, topic: '大语言模型在学术写作中的应用与伦理挑战', date: '2026-07-14', status: 'done' as const },
  { id: 2, topic: '量子计算对密码学安全的影响评估', date: '2026-07-11', status: 'done' as const },
  { id: 3, topic: '可解释 AI 在医疗诊断领域的最新进展', date: '2026-07-08', status: 'done' as const },
]

const mockResult = `## 研究报告：大语言模型在学术写作中的应用

### 1. 背景概述
近年来，以 GPT、Claude 为代表的大语言模型在学术写作辅助领域展现出显著潜力。

### 2. 关键发现
- 文献综述效率提升 40-60%
- 语法校正准确率达 95% 以上
- 跨语言翻译质量显著改善

### 3. 伦理考量
- 学术诚信边界需要明确界定
- 版权与归属问题尚待解决
- 各期刊对 AI 辅助写作的政策差异较大

### 4. 建议
建议学术机构制定明确的 AI 使用指南...`

export default function DeepResearch() {
  const [topic, setTopic] = useState('')
  const [currentPhase, setCurrentPhase] = useState(0) // 0 = idle
  const [running, setRunning] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const intervalRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  function handleStart() {
    if (!topic.trim()) return
    setRunning(true)
    setCurrentPhase(1)
    setShowResult(false)

    let phase = 1
    intervalRef.current = window.setInterval(() => {
      phase++
      if (phase > 5) {
        clearInterval(intervalRef.current!)
        intervalRef.current = null
        setRunning(false)
        setShowResult(true)
        setCurrentPhase(6)
        return
      }
      setCurrentPhase(phase)
    }, 1500)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>深度研究</h1>
        <p>AI 驱动的多阶段调研</p>
      </div>

      <div className="page-body">
        {/* Research Input */}
        <div className="card animate-in">
          <label className="text-sm font-medium text-ink block mb-2">研究课题</label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="输入您想深入研究的课题，AI 将进行多阶段调研..."
            rows={4}
            className="input w-full resize-none"
          />
          <button
            onClick={handleStart}
            disabled={running || !topic.trim()}
            className="btn btn-primary btn-block mt-3"
          >
            {running ? '研究中...' : '开始研究'}
          </button>
        </div>

        {/* Phase Stepper */}
        <div className="card animate-in" style={{ animationDelay: '60ms' }}>
          <h2 className="text-sm font-semibold text-ink mb-4">研究阶段</h2>
          <div className="flex items-center justify-between px-1">
            {phases.map((phase, i) => {
              const isCompleted = currentPhase > phase.id
              const isCurrent = currentPhase === phase.id
              const isIdle = currentPhase === 0 || currentPhase < phase.id

              return (
                <div key={phase.id} className="flex items-center flex-1 last:flex-none">
                  {/* Circle */}
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className={`
                        w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold
                        transition-all duration-300
                        ${isCompleted
                          ? 'bg-primary text-white'
                          : isCurrent
                            ? 'bg-primary text-white ring-4 ring-primary/20'
                            : 'bg-surface-2 text-ink-dim'
                        }
                      `}
                    >
                      {isCompleted ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        phase.id
                      )}
                      {isCurrent && running && (
                        <span className="absolute w-8 h-8 rounded-full bg-primary/30 animate-ping" />
                      )}
                    </div>
                    <span className={`text-[10px] font-medium whitespace-nowrap ${isCurrent ? 'text-ink' : isCompleted ? 'text-done' : 'text-ink-dim'}`}>
                      {phase.label}
                    </span>
                  </div>

                  {/* Connector line */}
                  {i < phases.length - 1 && (
                    <div
                      className={`h-0.5 flex-1 mx-1 mt-[-18px] rounded transition-colors duration-300 ${
                        isCompleted ? 'bg-primary' : 'bg-line'
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Results */}
        {showResult && (
          <div className="card animate-in">
            <h2 className="text-sm font-semibold text-ink mb-3">研究结果</h2>
            <div className="bg-surface rounded-xl border border-line-soft p-4">
              <pre className="text-sm text-ink leading-relaxed whitespace-pre-wrap font-sans">
                {mockResult}
              </pre>
            </div>
          </div>
        )}

        {/* History */}
        <div className="card animate-in" style={{ animationDelay: '120ms' }}>
          <h2 className="text-sm font-semibold text-ink mb-3">研究历史</h2>
          <div className="flex flex-col gap-2">
            {mockHistory.map((h) => (
              <div key={h.id} className="card-flat p-3 flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink leading-snug">{h.topic}</p>
                  <span className="text-xs text-ink-dim mt-1 block">{h.date}</span>
                </div>
                <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full badge-mint">
                  已完成
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
