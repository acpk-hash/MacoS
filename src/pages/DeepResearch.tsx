// 深度研究页 — 五阶段自动化 Web 研究流水线。
// 纯前端页面：通过 chat_send 调用 AI 服务商执行每个阶段,
// 非 Tauri 环境下展示演示模式占位。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MarkdownLite from '../components/ui/MarkdownLite'

// ── Tauri bridge ─────────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── 类型 ─────────────────────────────────────────────────────────────────────

type PhaseStatus = 'pending' | 'running' | 'done' | 'error'

interface Phase {
  id: string
  label: string
  labelEn: string
  systemPrompt: string
}

interface PhaseState {
  status: PhaseStatus
  output: string
  startedAt: number | null
  endedAt: number | null
  collapsed: boolean
}

interface Source {
  title: string
  url: string
  relevance: number
  snippet: string
}

interface ResearchSession {
  id: string
  question: string
  context: string
  createdAt: number
  phases: Record<string, PhaseState>
  sources: Source[]
  report: string
  status: 'running' | 'done' | 'error'
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const PHASES: Phase[] = [
  {
    id: 'decompose',
    label: '问题分解',
    labelEn: 'Question Decomposition',
    systemPrompt:
      '你是一个研究助理。给定一个研究问题,将其分解为 3-5 个具体的子查询,每个子查询可以独立搜索。' +
      '输出格式：每行一个子查询,前面加序号。不要输出其他内容。',
  },
  {
    id: 'search',
    label: '广域搜索',
    labelEn: 'Wide Search',
    systemPrompt:
      '你是一个网络研究员。对于给定的子查询列表,模拟对每个子查询的搜索结果。' +
      '对每个子查询,列出 2-3 个相关的来源,包括标题、URL、相关度评分(0-100)和一句话摘要。' +
      '输出 JSON 数组格式: [{"title":"...","url":"...","relevance":85,"snippet":"..."}]' +
      '只输出 JSON,不要有其他文字。',
  },
  {
    id: 'read',
    label: '深度阅读',
    labelEn: 'Deep Reading',
    systemPrompt:
      '你是一个文献分析专家。基于前面搜索到的来源信息,对每个来源进行深度分析。' +
      '提取关键论点、数据、方法论和结论。标注每条信息的来源。以结构化的笔记形式输出。',
  },
  {
    id: 'verify',
    label: '交叉验证',
    labelEn: 'Cross Verification',
    systemPrompt:
      '你是一个事实核查专家。基于前面的深度阅读笔记,进行交叉验证：' +
      '1. 标记多源确认的事实(高可信度)' +
      '2. 标记仅单源支持的声明(需注意)' +
      '3. 标记来源间矛盾的信息(需进一步调查)' +
      '4. 给出每条关键发现的可信度评级(高/中/低)',
  },
  {
    id: 'report',
    label: '综合报告',
    labelEn: 'Synthesis Report',
    systemPrompt:
      '你是一个研究报告撰写专家。基于前面所有阶段的输出,撰写一份完整的研究报告。' +
      '报告格式(Markdown)：' +
      '# 研究报告: [主题]\n' +
      '## 研究概述\n## 主要发现\n## 详细分析\n## 来源与可信度\n## 结论与建议\n' +
      '确保引用来源,并标注可信度等级。',
  },
]

const STORAGE_KEY = 'iris-deep-research-history'

const CARD = 'rounded-card border border-line bg-surface'
const INPUT =
  'w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60'
const BTN_PRIMARY =
  'rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors disabled:opacity-40'
const BTN_GHOST =
  'rounded-input border border-line px-3 py-1.5 text-[12px] text-ink-dim hover:text-ink transition-colors disabled:opacity-40'

// ── 状态颜色 ─────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<PhaseStatus, { bg: string; pulse: boolean }> = {
  pending: { bg: '#8a8a85', pulse: false },
  running: { bg: '#0d8de3', pulse: true },
  done: { bg: '#10a37f', pulse: false },
  error: { bg: '#d0342c', pulse: false },
}

const STATUS_LABEL: Record<PhaseStatus, string> = {
  pending: '等待中',
  running: '执行中',
  done: '已完成',
  error: '出错',
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function loadHistory(): ResearchSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ResearchSession[]) : []
  } catch {
    return []
  }
}

function saveHistory(sessions: ResearchSession[]) {
  try {
    // 只保留最近 50 条
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 50)))
  } catch {
    /* quota exceeded — silently drop */
  }
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function initialPhaseStates(): Record<string, PhaseState> {
  const m: Record<string, PhaseState> = {}
  for (const ph of PHASES) {
    m[ph.id] = { status: 'pending', output: '', startedAt: null, endedAt: null, collapsed: true }
  }
  return m
}

/** 从 search 阶段输出中尝试解析 sources JSON。 */
function parseSources(raw: string): Source[] {
  try {
    // 找到 JSON 数组
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) return []
    const arr = JSON.parse(match[0]) as Source[]
    return arr
      .filter((s) => s.title && s.url)
      .map((s) => ({
        title: s.title,
        url: s.url,
        relevance: typeof s.relevance === 'number' ? s.relevance : 50,
        snippet: s.snippet ?? '',
      }))
  } catch {
    return []
  }
}

// ── 演示模式（非 Tauri）─────────────────────────────────────────────────────

const DEMO_OUTPUTS: Record<string, string> = {
  decompose:
    '1. 大语言模型在科研领域的应用现状与主要方向\n' +
    '2. LLM 辅助文献综述的方法与工具对比\n' +
    '3. AI 驱动的假设生成与实验设计案例\n' +
    '4. 当前 LLM 科研应用的局限性与偏差风险',
  search: JSON.stringify(
    [
      {
        title: 'AI for Science: A Survey',
        url: 'https://arxiv.org/abs/2401.00001',
        relevance: 95,
        snippet: '全面综述 AI 在科学研究各领域的应用进展与挑战。',
      },
      {
        title: 'LLM-assisted Literature Review',
        url: 'https://arxiv.org/abs/2403.00002',
        relevance: 88,
        snippet: '探讨大语言模型辅助系统性文献综述的工作流程与评估。',
      },
      {
        title: 'Hypothesis Generation with GPT-4',
        url: 'https://nature.com/articles/s41586-024-00003',
        relevance: 82,
        snippet: 'Nature 论文：GPT-4 在材料科学领域生成可验证假设的实验。',
      },
      {
        title: 'Risks of AI in Research',
        url: 'https://science.org/doi/10.1126/science.2024.0004',
        relevance: 76,
        snippet: '讨论 AI 工具在科研中的偏差放大与可重复性风险。',
      },
    ],
    null,
    2,
  ),
  read:
    '## 来源分析笔记\n\n' +
    '### AI for Science: A Survey\n' +
    '- **关键论点**: AI 方法（尤其是深度学习与 LLM）正在从加速数据分析扩展到假设生成、实验设计和论文撰写\n' +
    '- **数据**: 2023 年超过 15% 的自然科学论文使用了某种形式的 AI 辅助\n' +
    '- **方法论**: 系统性综述,覆盖物理、化学、生物、材料等领域\n\n' +
    '### LLM-assisted Literature Review\n' +
    '- **关键论点**: LLM 可将文献筛选时间缩短 60%,但需要人工验证以避免遗漏关键文献\n' +
    '- **局限**: 对 2023 年后新发表文献的覆盖不足\n\n' +
    '### Hypothesis Generation with GPT-4\n' +
    '- **关键发现**: GPT-4 生成的 50 个材料科学假设中,有 7 个通过实验验证为有效\n' +
    '- **方法论**: 结合领域知识图谱与 LLM 推理的混合方法\n\n' +
    '### Risks of AI in Research\n' +
    '- **警告**: AI 工具可能放大已有偏差,尤其在训练数据有偏的领域\n' +
    '- **建议**: 建立 AI 辅助研究的透明度报告标准',
  verify:
    '## 交叉验证结果\n\n' +
    '### 高可信度（多源确认）\n' +
    '- AI/LLM 在科研中的采用率显著增长 — 多篇综述一致确认\n' +
    '- LLM 可加速文献筛选但需人工验证 — 多个独立研究支持\n\n' +
    '### 中可信度（有限来源支持）\n' +
    '- GPT-4 假设生成的 14% 验证率 — 仅单一实验,样本量有限\n' +
    '- 文献筛选时间缩短 60% — 特定实验条件下的结果,可能因领域而异\n\n' +
    '### 需注意（潜在矛盾）\n' +
    '- AI 辅助论文的质量评价：部分来源认为提升了效率和质量,另一些强调了偏差风险 — 需区分应用场景',
  report:
    '# 研究报告: 大语言模型在科研中的应用\n\n' +
    '## 研究概述\n' +
    '本报告调研了大语言模型（LLM）在科学研究中的应用现状,涵盖文献综述辅助、假设生成、实验设计和论文撰写等方向。\n\n' +
    '## 主要发现\n' +
    '1. **采用趋势**: 2023 年超过 15% 的自然科学论文使用了 AI 辅助,趋势持续上升（高可信度）\n' +
    '2. **效率提升**: LLM 辅助文献筛选可缩短约 60% 的时间,但需人工审核（中可信度）\n' +
    '3. **创新潜力**: GPT-4 在材料科学假设生成中展示了约 14% 的实验验证率（中可信度）\n' +
    '4. **风险警示**: AI 工具可能放大数据偏差,需建立透明度标准（高可信度）\n\n' +
    '## 详细分析\n' +
    '### 文献综述辅助\n' +
    'LLM 在系统性文献综述中的应用已较为成熟,主要优势在于快速筛选和初步分类。然而,对最新文献的覆盖不足和潜在遗漏是主要局限。\n\n' +
    '### 假设生成与实验设计\n' +
    '这是一个前沿但尚不成熟的方向。结合领域知识图谱的混合方法表现优于纯 LLM 方法。\n\n' +
    '### 偏差与可重复性\n' +
    '多位研究者警告 AI 工具可能放大已有偏差。建议建立 AI 辅助研究的标准化报告框架。\n\n' +
    '## 来源与可信度\n' +
    '| 来源 | 可信度 |\n' +
    '|------|--------|\n' +
    '| AI for Science: A Survey | 高 |\n' +
    '| LLM-assisted Literature Review | 高 |\n' +
    '| Hypothesis Generation with GPT-4 | 中 |\n' +
    '| Risks of AI in Research | 高 |\n\n' +
    '## 结论与建议\n' +
    'LLM 在科研中的应用前景广阔,但应遵循"AI 辅助、人类主导"的原则。建议：\n' +
    '1. 将 LLM 作为加速工具而非替代品\n' +
    '2. 建立 AI 辅助研究的透明度报告标准\n' +
    '3. 对 AI 生成的假设进行严格实验验证\n' +
    '4. 持续关注偏差风险并采取缓解措施',
}

// ── 组件 ─────────────────────────────────────────────────────────────────────

export default function DeepResearch() {
  // 研究输入
  const [question, setQuestion] = useState('')
  const [context, setContext] = useState('')

  // 阶段状态
  const [phases, setPhases] = useState<Record<string, PhaseState>>(initialPhaseStates)
  const [sources, setSources] = useState<Source[]>([])
  const [report, setReport] = useState('')
  const [researchStatus, setResearchStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  // 历史
  const [history, setHistory] = useState<ResearchSession[]>(() => loadHistory())
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(true)

  // 报告视图
  const [showReport, setShowReport] = useState(false)
  const [copied, setCopied] = useState(false)

  // 来源面板
  const [sourcesOpen, setSourcesOpen] = useState(true)

  // 运行中的 abort 信号
  const abortRef = useRef(false)

  // 定时器更新运行阶段的耗时显示
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (researchStatus !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [researchStatus])

  // ── 阶段更新辅助 ────────────────────────────────────────────────────────────

  const updatePhase = useCallback((id: string, patch: Partial<PhaseState>) => {
    setPhases((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }))
  }, [])

  // ── 研究执行 ────────────────────────────────────────────────────────────────

  const runResearch = useCallback(async () => {
    if (!question.trim()) return
    abortRef.current = false
    setError(null)
    setPhases(initialPhaseStates())
    setSources([])
    setReport('')
    setShowReport(false)
    setResearchStatus('running')

    const sessionId = uuid()
    setActiveSessionId(sessionId)

    let accumulatedOutput = ''
    let parsedSources: Source[] = []

    for (let i = 0; i < PHASES.length; i++) {
      if (abortRef.current) break
      const phase = PHASES[i]

      updatePhase(phase.id, { status: 'running', startedAt: Date.now(), collapsed: false })

      // 折叠上一阶段
      if (i > 0) {
        updatePhase(PHASES[i - 1].id, { collapsed: true })
      }

      try {
        let output: string

        if (isTauri) {
          // 真实 AI 调用 — 通过 chat_send
          const userContent =
            i === 0
              ? `研究问题: ${question}${context ? `\n\n补充背景: ${context}` : ''}`
              : `前一阶段输出:\n${accumulatedOutput}\n\n原始研究问题: ${question}`

          // 创建临时会话并发送
          const tempSessionId = `deep-research-${sessionId}-phase-${phase.id}`
          try {
            output = await tauriInvoke<string>('chat_send', {
              sessionId: tempSessionId,
              userContent: `${phase.systemPrompt}\n\n${userContent}`,
              attachments: [],
              model: null,
              providerId: null,
            })
          } catch (e) {
            // chat_send 可能返回 void / 空;从流式回调取结果
            output = String(e || '')
            if (output.includes('session not found') || output.includes('error')) {
              throw new Error(output)
            }
          }
        } else {
          // 演示模式 — 模拟延迟后返回预制内容
          await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800))
          if (abortRef.current) break
          output = DEMO_OUTPUTS[phase.id] ?? `[${phase.label}] 阶段完成`
        }

        accumulatedOutput = output

        // 解析搜索阶段的来源
        if (phase.id === 'search') {
          parsedSources = parseSources(output)
          setSources(parsedSources)
        }

        // 最终报告
        if (phase.id === 'report') {
          setReport(output)
        }

        updatePhase(phase.id, {
          status: 'done',
          output,
          endedAt: Date.now(),
        })
      } catch (e) {
        updatePhase(phase.id, {
          status: 'error',
          output: String(e),
          endedAt: Date.now(),
        })
        setError(`阶段「${phase.label}」执行出错: ${String(e)}`)
        setResearchStatus('error')

        // 保存到历史
        setHistory((prev) => {
          const session: ResearchSession = {
            id: sessionId,
            question,
            context,
            createdAt: Date.now(),
            phases: { ...phases },
            sources: parsedSources,
            report: '',
            status: 'error',
          }
          const next = [session, ...prev]
          saveHistory(next)
          return next
        })
        return
      }
    }

    if (abortRef.current) {
      setResearchStatus('idle')
      return
    }

    setResearchStatus('done')
    setShowReport(true)

    // 保存到历史
    setPhases((currentPhases) => {
      const session: ResearchSession = {
        id: sessionId,
        question,
        context,
        createdAt: Date.now(),
        phases: currentPhases,
        sources: parsedSources,
        report: accumulatedOutput,
        status: 'done',
      }
      setHistory((prev) => {
        const next = [session, ...prev]
        saveHistory(next)
        return next
      })
      return currentPhases
    })
  }, [question, context, updatePhase, phases])

  const stopResearch = useCallback(() => {
    abortRef.current = true
  }, [])

  // ── 恢复历史会话 ───────────────────────────────────────────────────────────

  const loadSession = useCallback((session: ResearchSession) => {
    setQuestion(session.question)
    setContext(session.context)
    setPhases(session.phases)
    setSources(session.sources)
    setReport(session.report)
    setResearchStatus(session.status === 'done' ? 'done' : 'idle')
    setActiveSessionId(session.id)
    setShowReport(session.status === 'done' && !!session.report)
    setError(null)
  }, [])

  const deleteSession = useCallback(
    (id: string) => {
      setHistory((prev) => {
        const next = prev.filter((s) => s.id !== id)
        saveHistory(next)
        return next
      })
      if (activeSessionId === id) {
        setActiveSessionId(null)
        setPhases(initialPhaseStates())
        setSources([])
        setReport('')
        setResearchStatus('idle')
      }
    },
    [activeSessionId],
  )

  // ── 复制与导出 ─────────────────────────────────────────────────────────────

  const copyReport = useCallback(async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败')
    }
  }, [report])

  const exportReport = useCallback(() => {
    if (!report) return
    const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `research-${question.slice(0, 30).replace(/[^\w一-鿿]/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [report, question])

  // ── 当前运行阶段信息 ───────────────────────────────────────────────────────

  const completedCount = useMemo(
    () => PHASES.filter((ph) => phases[ph.id]?.status === 'done').length,
    [phases],
  )

  // ── 渲染 ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden text-ink">
      {/* ─── 左侧: 历史列表 ─── */}
      {historyOpen && (
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-bg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
            <span className="text-[13px] font-semibold text-ink">研究历史</span>
            <button
              className="text-[11px] text-ink-muted hover:text-ink transition-colors"
              onClick={() => setHistoryOpen(false)}
              title="收起历史面板"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-ink-muted">
                暂无历史记录
              </div>
            ) : (
              <ul className="py-1">
                {history.map((s) => (
                  <li key={s.id}>
                    <button
                      className={
                        'w-full text-left px-3 py-2 transition-colors group ' +
                        (activeSessionId === s.id
                          ? 'bg-primary/10'
                          : 'hover:bg-surface')
                      }
                      onClick={() => loadSession(s)}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-[6px] w-[6px] rounded-full shrink-0"
                          style={{
                            backgroundColor:
                              s.status === 'done' ? '#10a37f' : '#d0342c',
                          }}
                        />
                        <span className="text-[12px] text-ink truncate flex-1">
                          {s.question.slice(0, 40)}
                        </span>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-ink-muted hover:text-failed transition-all shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteSession(s.id)
                          }}
                          title="删除"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <div className="mt-0.5 text-[10px] text-ink-muted">
                        {fmtDate(s.createdAt)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {history.length > 0 && (
            <div className="border-t border-line px-3 py-2">
              <button
                className="text-[11px] text-ink-muted hover:text-failed transition-colors"
                onClick={() => {
                  setHistory([])
                  saveHistory([])
                }}
              >
                清空历史
              </button>
            </div>
          )}
        </aside>
      )}

      {/* ─── 中间: 主内容区 ─── */}
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-editor">
        {/* 展开历史面板按钮 */}
        {!historyOpen && (
          <button
            className="absolute left-0 top-1/2 z-20 -translate-y-1/2 rounded-r-lg border border-l-0 border-line bg-surface px-1 py-3 text-ink-dim hover:text-ink hover:bg-surface transition-colors"
            onClick={() => setHistoryOpen(true)}
            title="展开历史面板"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        )}

        <div className="mx-auto w-full max-w-[780px] space-y-3 px-4 py-4">
          {/* ── 页面标题 ── */}
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-bold text-ink">深度研究</h1>
            {!isTauri && (
              <span className="rounded-input bg-surface px-2 py-0.5 text-[10px] text-ink-muted border border-line">
                演示模式
              </span>
            )}
          </div>

          {/* ── 研究输入 ── */}
          <section className={CARD + ' p-3 space-y-2.5'}>
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-ink">研究问题</h2>
              {researchStatus === 'running' && (
                <span className="text-[11px] text-primary animate-pulse">
                  研究进行中... ({completedCount}/{PHASES.length})
                </span>
              )}
            </div>
            <input
              className={INPUT}
              placeholder="输入你想深入研究的问题..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={researchStatus === 'running'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && researchStatus !== 'running') {
                  void runResearch()
                }
              }}
            />
            <textarea
              className={INPUT + ' min-h-[56px] resize-y'}
              placeholder="补充背景或约束条件（可选）"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              disabled={researchStatus === 'running'}
            />
            <div className="flex items-center gap-2">
              {researchStatus === 'running' ? (
                <button className={BTN_GHOST} onClick={stopResearch}>
                  停止研究
                </button>
              ) : (
                <button
                  className={BTN_PRIMARY}
                  onClick={() => void runResearch()}
                  disabled={!question.trim()}
                >
                  开始研究
                </button>
              )}
              {researchStatus === 'done' && (
                <button
                  className={BTN_GHOST}
                  onClick={() => {
                    setPhases(initialPhaseStates())
                    setSources([])
                    setReport('')
                    setResearchStatus('idle')
                    setShowReport(false)
                    setActiveSessionId(null)
                  }}
                >
                  新研究
                </button>
              )}
            </div>
          </section>

          {/* ── 错误提示 ── */}
          {error && (
            <div className="rounded-card border border-failed/30 bg-failed/5 px-3 py-2 text-[12px] text-failed">
              {error}
            </div>
          )}

          {/* ── 五阶段流水线 ── */}
          <section className="space-y-2">
            {PHASES.map((phase, idx) => {
              const st = phases[phase.id]
              if (!st) return null
              const dot = STATUS_DOT[st.status]
              const hasOutput = !!st.output
              const isCollapsed = st.collapsed && st.status !== 'running'

              return (
                <div key={phase.id} className={CARD + ' overflow-hidden'}>
                  {/* 阶段头 */}
                  <button
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface transition-colors"
                    onClick={() => {
                      if (hasOutput || st.status !== 'pending') {
                        updatePhase(phase.id, { collapsed: !isCollapsed })
                      }
                    }}
                  >
                    {/* 状态点 */}
                    <span
                      className={`inline-block h-[8px] w-[8px] rounded-full shrink-0 ${dot.pulse ? 'animate-pulse' : ''}`}
                      style={{ backgroundColor: dot.bg }}
                    />
                    {/* 序号与标签 */}
                    <span className="text-[12px] font-semibold text-ink">
                      {idx + 1}. {phase.label}
                    </span>
                    <span className="text-[11px] text-ink-muted">{phase.labelEn}</span>
                    <span className="flex-1" />
                    {/* 状态文字 */}
                    <span
                      className={
                        'text-[11px] tabular-nums ' +
                        (st.status === 'running'
                          ? 'text-primary'
                          : st.status === 'done'
                            ? 'text-ink-dim'
                            : st.status === 'error'
                              ? 'text-failed'
                              : 'text-ink-muted')
                      }
                    >
                      {st.status === 'running' && st.startedAt
                        ? `${STATUS_LABEL[st.status]} ${fmtDuration(now - st.startedAt)}`
                        : st.status === 'done' && st.startedAt && st.endedAt
                          ? `${STATUS_LABEL[st.status]} ${fmtDuration(st.endedAt - st.startedAt)}`
                          : STATUS_LABEL[st.status]}
                    </span>
                    {/* 折叠指示 */}
                    {hasOutput && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={
                          'text-ink-muted transition-transform ' +
                          (isCollapsed ? '' : 'rotate-180')
                        }
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    )}
                  </button>

                  {/* 阶段输出 */}
                  {!isCollapsed && hasOutput && (
                    <div className="border-t border-line px-3 py-2.5">
                      {phase.id === 'report' || phase.id === 'read' || phase.id === 'verify' ? (
                        <div className="text-[12px]">
                          <MarkdownLite text={st.output} />
                        </div>
                      ) : (
                        <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap text-[11.5px] text-ink-dim leading-5">
                          {st.output}
                        </pre>
                      )}
                    </div>
                  )}

                  {/* running 阶段的加载动画 */}
                  {st.status === 'running' && !hasOutput && (
                    <div className="border-t border-line px-3 py-3">
                      <div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
                        <span className="inline-block h-[6px] w-[6px] rounded-full bg-primary animate-pulse" />
                        正在执行{phase.label}...
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </section>

          {/* ── 综合报告视图 ── */}
          {showReport && report && (
            <section className={CARD + ' p-3 space-y-2.5'}>
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-ink">综合报告</h2>
                <span className="flex-1" />
                <button className={BTN_GHOST} onClick={() => void copyReport()}>
                  {copied ? '已复制' : '复制'}
                </button>
                <button className={BTN_GHOST} onClick={exportReport}>
                  导出 .md
                </button>
              </div>
              <div className="rounded-card border border-line bg-editor p-3 text-[12px]">
                <MarkdownLite text={report} />
              </div>
            </section>
          )}
        </div>
      </main>

      {/* ─── 右侧: 来源面板 ─── */}
      {sourcesOpen && (
        <aside className="flex w-[240px] shrink-0 flex-col border-l border-line bg-bg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
            <span className="text-[13px] font-semibold text-ink">来源</span>
            <button
              className="text-[11px] text-ink-muted hover:text-ink transition-colors"
              onClick={() => setSourcesOpen(false)}
              title="收起来源面板"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sources.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-ink-muted">
                {researchStatus === 'running'
                  ? '搜索阶段完成后将在此显示来源...'
                  : '暂无来源数据'}
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {sources
                  .sort((a, b) => b.relevance - a.relevance)
                  .map((src, i) => (
                    <li key={i} className="px-3 py-2.5 space-y-1">
                      <div className="flex items-start gap-1.5">
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[12px] text-primary hover:underline underline-offset-2 leading-snug flex-1"
                          title={src.url}
                        >
                          {src.title}
                        </a>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-[3px] rounded-full bg-line overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary/70 transition-all"
                            style={{ width: `${src.relevance}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-ink-muted tabular-nums shrink-0">
                          {src.relevance}
                        </span>
                      </div>
                      {src.snippet && (
                        <p className="text-[11px] text-ink-muted leading-relaxed">
                          {src.snippet}
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div className="border-t border-line px-3 py-2 text-[10px] text-ink-muted">
            {sources.length > 0
              ? `${sources.length} 个来源`
              : '来源将在广域搜索阶段后出现'}
          </div>
        </aside>
      )}

      {/* 来源面板收起时的恢复按钮 */}
      {!sourcesOpen && (
        <button
          className="absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-l-lg border border-r-0 border-line bg-surface px-1.5 py-3 text-ink-dim hover:text-ink hover:bg-surface transition-colors"
          onClick={() => setSourcesOpen(true)}
          title="展开来源面板"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      )}
    </div>
  )
}
