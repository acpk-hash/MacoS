// 模型盲测 — 多模型 A/B 对比盲测页。
// 设计: 选 2-4 个模型 → 同时发送同一 prompt → 匿名展示 → 用户投票 → 揭晓模型名称。
// 数据通道: chat_sessions_create + chat_send + studio-event（按 session_id 分发），
// 模型列表走 providers_models，与 scienceStore / commerceStore 相同的封装模式。
// 历史 & ELO 排名持久化到 localStorage（iris-model-compare）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ── Tauri guard ──────────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

// ── Types ────────────────────────────────────────────────────────────────────

interface RawAggModel {
  kind: string
  provider_id: string
  provider_label: string
  model_id: string
}

interface AggModel {
  providerId: string
  providerLabel: string
  modelId: string
  kind: string
}

interface StudioEvent {
  type: string
  session_id?: string
  message_id?: string
  text?: string
  status?: string
  message?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost?: number
}

/** A single model slot in a comparison run. */
interface ModelSlot {
  /** Composite key: providerId|modelId */
  modelKey: string
  providerId: string
  modelId: string
  providerLabel: string
  /** Anonymized label: 模型 A / B / C / D */
  anonLabel: string
  sessionId: string | null
  /** Accumulated streaming text */
  text: string
  status: 'pending' | 'streaming' | 'done' | 'error'
  error: string | null
  startTime: number
  endTime: number | null
  inputTokens: number
  outputTokens: number
  cost: number
}

/** Persisted record of a single comparison session. */
interface CompareRecord {
  id: string
  timestamp: number
  prompt: string
  presetLabel: string | null
  slots: {
    modelKey: string
    modelId: string
    providerLabel: string
    anonLabel: string
    text: string
    elapsedMs: number
    inputTokens: number
    outputTokens: number
    cost: number
  }[]
  /** modelKey of winner, or 'tie', or null if not voted */
  winner: string | null
}

/** Aggregate stats per model. */
interface ModelStats {
  modelKey: string
  modelId: string
  providerLabel: string
  wins: number
  losses: number
  ties: number
  total: number
  winRate: number
  elo: number
  avgTimeMs: number
}

// ── Preset prompts ───────────────────────────────────────────────────────────

const PRESETS = [
  {
    label: '代码生成',
    prompt:
      '请用 Python 实现一个高效的 LRU Cache 类，支持 get 和 put 操作，时间复杂度 O(1)。包含完整的类型注释和简短的使用示例。',
  },
  {
    label: '创意写作',
    prompt:
      '请以"深夜的自动售货机"为主题，写一篇 300 字左右的微型小说。要求有转折和令人回味的结尾。',
  },
  {
    label: '逻辑推理',
    prompt:
      'A、B、C 三人中有一个人总说真话，一个人总说假话，一个人随机说真话或假话。A 说："我不是随机的。" B 说："A 说的是真话。" C 说："我是随机的。" 请推理谁是说真话的，谁是说假话的，谁是随机的？给出详细推理过程。',
  },
  {
    label: '翻译',
    prompt:
      '请将以下中文翻译为地道的英文，保留学术风格：\n\n"大语言模型的涌现能力是指模型在规模超过一定阈值后突然展现出的、在小规模模型中不存在的能力。这一现象引发了关于模型行为可预测性的深层讨论。"',
  },
  {
    label: '总结',
    prompt:
      '请将以下段落总结为 3 个要点，每个要点一句话：\n\n"人工智能的发展已经从专用系统转向了通用大模型。GPT-4、Claude、Gemini 等模型不仅可以处理文本，还能理解和生成图像、代码和结构化数据。这些模型通过大规模预训练和指令微调获得了广泛的知识和推理能力。然而，它们仍然面临幻觉、推理一致性和安全对齐等挑战。学术界和产业界正在积极探索检索增强生成（RAG）、思维链提示和多代理系统等方法来应对这些问题。"',
  },
]

// ── Constants ────────────────────────────────────────────────────────────────

const ANON_LABELS = ['模型 A', '模型 B', '模型 C', '模型 D']
const STORAGE_KEY = 'iris-model-compare'
const ELO_K = 32
const ELO_DEFAULT = 1200

// ── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'mc-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Fisher-Yates shuffle (returns new array). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function loadHistory(): CompareRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CompareRecord[]) : []
  } catch {
    return []
  }
}

function saveHistory(records: CompareRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    /* quota exceeded — silently drop oldest */
  }
}

/** Compute ELO-style rankings from history. */
function computeStats(records: CompareRecord[]): ModelStats[] {
  const map = new Map<
    string,
    {
      modelId: string
      providerLabel: string
      wins: number
      losses: number
      ties: number
      totalTimeMs: number
      timeSamples: number
      elo: number
    }
  >()

  function ensure(key: string, modelId: string, providerLabel: string) {
    if (!map.has(key)) {
      map.set(key, {
        modelId,
        providerLabel,
        wins: 0,
        losses: 0,
        ties: 0,
        totalTimeMs: 0,
        timeSamples: 0,
        elo: ELO_DEFAULT,
      })
    }
    return map.get(key)!
  }

  // First pass: accumulate time stats
  for (const r of records) {
    for (const s of r.slots) {
      const st = ensure(s.modelKey, s.modelId, s.providerLabel)
      if (s.elapsedMs > 0) {
        st.totalTimeMs += s.elapsedMs
        st.timeSamples++
      }
    }
  }

  // Second pass: ELO + win/loss/tie (compare winner against each loser pairwise)
  for (const r of records) {
    if (!r.winner) continue
    const slots = r.slots
    for (const s of slots) {
      ensure(s.modelKey, s.modelId, s.providerLabel)
    }

    if (r.winner === 'tie') {
      // All participants get a tie
      for (const s of slots) {
        map.get(s.modelKey)!.ties++
      }
      // ELO: each pair draws
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const a = map.get(slots[i].modelKey)!
          const b = map.get(slots[j].modelKey)!
          const ea = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400))
          const eb = 1 - ea
          a.elo += ELO_K * (0.5 - ea)
          b.elo += ELO_K * (0.5 - eb)
        }
      }
    } else {
      // Winner vs each loser
      const winnerSt = map.get(r.winner)!
      winnerSt.wins++
      for (const s of slots) {
        if (s.modelKey === r.winner) continue
        const loserSt = map.get(s.modelKey)!
        loserSt.losses++
        // ELO update
        const ea = 1 / (1 + Math.pow(10, (loserSt.elo - winnerSt.elo) / 400))
        const eb = 1 - ea
        winnerSt.elo += ELO_K * (1 - ea)
        loserSt.elo += ELO_K * (0 - eb)
      }
    }
  }

  const stats: ModelStats[] = []
  for (const [key, st] of map) {
    const total = st.wins + st.losses + st.ties
    stats.push({
      modelKey: key,
      modelId: st.modelId,
      providerLabel: st.providerLabel,
      wins: st.wins,
      losses: st.losses,
      ties: st.ties,
      total,
      winRate: total > 0 ? st.wins / total : 0,
      elo: Math.round(st.elo),
      avgTimeMs: st.timeSamples > 0 ? Math.round(st.totalTimeMs / st.timeSamples) : 0,
    })
  }
  stats.sort((a, b) => b.elo - a.elo)
  return stats
}

function fmtMs(ms: number): string {
  if (ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtTokens(n: number): string {
  if (n <= 0) return '-'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

function fmtCost(c: number): string {
  if (c <= 0) return '-'
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(3)}`
}

// ── Event listener (module-level singleton, like scienceStore) ────────────────

interface PendingSlot {
  onDelta: (text: string) => void
  onDone: (text: string, usage: { input: number; output: number; cost: number }) => void
  onError: (msg: string) => void
}

const pendingSlots = new Map<string, PendingSlot>()
let listenerReady = false

async function ensureListener(): Promise<void> {
  if (listenerReady || !isTauri) return
  listenerReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const buffers = new Map<string, string>()
    await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      const sid = p.session_id
      if (!sid || !pendingSlots.has(sid)) return
      const slot = pendingSlots.get(sid)!
      if (p.type === 'delta') {
        const buf = (buffers.get(sid) ?? '') + (p.text ?? '')
        buffers.set(sid, buf)
        slot.onDelta(buf)
      } else if (p.type === 'done') {
        pendingSlots.delete(sid)
        const finalText = p.text || buffers.get(sid) || ''
        buffers.delete(sid)
        slot.onDone(finalText, {
          input: p.input_tokens ?? 0,
          output: p.output_tokens ?? 0,
          cost: p.cost ?? 0,
        })
      } else if (p.type === 'error') {
        pendingSlots.delete(sid)
        buffers.delete(sid)
        slot.onError(p.message ?? '生成出错')
      }
    })
  } catch (err) {
    listenerReady = false
    console.warn('[ModelCompare] studio-event listener failed:', err)
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ModelCompare() {
  // ── Model list ─────────────────────────────────────────────────────────────
  const [allModels, setAllModels] = useState<AggModel[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri) {
      setModelsLoaded(true)
      return
    }
    tauriInvoke<RawAggModel[]>('providers_models')
      .then((raw) => {
        const models = raw
          .filter((m) => (m.kind ?? 'chat') === 'chat')
          .map((m) => ({
            providerId: m.provider_id,
            providerLabel: m.provider_label,
            modelId: m.model_id,
            kind: m.kind ?? 'chat',
          }))
        setAllModels(models)
        setModelsLoaded(true)
      })
      .catch((e) => {
        setModelsError(String(e))
        setModelsLoaded(true)
      })
  }, [])

  const modelGroups = useMemo(() => {
    const groups: { providerId: string; providerLabel: string; items: AggModel[] }[] = []
    for (const m of allModels) {
      const g = groups.find((x) => x.providerId === m.providerId)
      if (g) g.items.push(m)
      else groups.push({ providerId: m.providerId, providerLabel: m.providerLabel, items: [m] })
    }
    return groups
  }, [allModels])

  // ── Setup state ────────────────────────────────────────────────────────────
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [prompt, setPrompt] = useState('')
  const [activePreset, setActivePreset] = useState<string | null>(null)

  // ── Run state ──────────────────────────────────────────────────────────────
  const [slots, setSlots] = useState<ModelSlot[]>([])
  const [phase, setPhase] = useState<'setup' | 'running' | 'voting' | 'revealed'>('setup')
  const [winner, setWinner] = useState<string | null>(null)
  const [revealAnim, setRevealAnim] = useState(false)

  // ── History ────────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<CompareRecord[]>(() => loadHistory())
  const [showHistory, setShowHistory] = useState(false)

  const stats = useMemo(() => computeStats(history), [history])

  // Ref to track slots during streaming (avoids stale closures)
  const slotsRef = useRef<ModelSlot[]>([])
  slotsRef.current = slots

  // ── Toggle model selection ─────────────────────────────────────────────────
  const toggleModel = useCallback(
    (key: string) => {
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
        } else if (next.size < 4) {
          next.add(key)
        }
        return next
      })
    },
    [],
  )

  // ── Start blind test ───────────────────────────────────────────────────────
  const startTest = useCallback(async () => {
    if (selectedKeys.size < 2 || !prompt.trim()) return
    if (!isTauri) return

    await ensureListener()

    // Build shuffled slots
    const selected = [...selectedKeys].map((key) => {
      const sep = key.indexOf('|')
      const providerId = key.slice(0, sep)
      const modelId = key.slice(sep + 1)
      const m = allModels.find((x) => x.providerId === providerId && x.modelId === modelId)
      return { key, providerId, modelId, providerLabel: m?.providerLabel ?? providerId }
    })
    const shuffled = shuffle(selected)

    const newSlots: ModelSlot[] = shuffled.map((s, i) => ({
      modelKey: s.key,
      providerId: s.providerId,
      modelId: s.modelId,
      providerLabel: s.providerLabel,
      anonLabel: ANON_LABELS[i],
      sessionId: null,
      text: '',
      status: 'pending',
      error: null,
      startTime: Date.now(),
      endTime: null,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    }))

    setSlots(newSlots)
    slotsRef.current = newSlots
    setPhase('running')
    setWinner(null)
    setRevealAnim(false)

    // Fire all model calls concurrently
    const updateSlot = (idx: number, patch: Partial<ModelSlot>) => {
      setSlots((prev) => {
        const next = [...prev]
        next[idx] = { ...next[idx], ...patch }
        return next
      })
    }

    const promises: Promise<void>[] = []

    for (let idx = 0; idx < newSlots.length; idx++) {
      const slot = newSlots[idx]
      const p = (async () => {
        try {
          // Create session
          const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
            title: `[盲测] ${slot.anonLabel}`,
            model: slot.modelId,
          })
          const sessionId = row.id
          updateSlot(idx, { sessionId, status: 'streaming', startTime: Date.now() })

          // Register streaming callbacks
          await new Promise<void>((resolve, reject) => {
            pendingSlots.set(sessionId, {
              onDelta: (text) => {
                updateSlot(idx, { text, status: 'streaming' })
              },
              onDone: (text, usage) => {
                updateSlot(idx, {
                  text,
                  status: 'done',
                  endTime: Date.now(),
                  inputTokens: usage.input,
                  outputTokens: usage.output,
                  cost: usage.cost,
                })
                resolve()
              },
              onError: (msg) => {
                updateSlot(idx, { status: 'error', error: msg, endTime: Date.now() })
                reject(new Error(msg))
              },
            })

            // Fire chat_send
            tauriInvoke<string>('chat_send', {
              sessionId,
              userContent: prompt.trim(),
              attachments: [],
              model: slot.modelId,
              providerId: slot.providerId,
            }).catch((e) => {
              pendingSlots.delete(sessionId)
              updateSlot(idx, { status: 'error', error: String(e), endTime: Date.now() })
              reject(e)
            })
          })
        } catch {
          // Error already patched into slot
        } finally {
          // Cleanup session
          const current = slotsRef.current[idx]
          if (current?.sessionId) {
            tauriInvoke<void>('chat_sessions_delete', { sessionId: current.sessionId }).catch(
              () => {},
            )
          }
        }
      })()
      promises.push(p)
    }

    // Wait for all to finish, then transition to voting
    await Promise.allSettled(promises)
    setPhase('voting')
  }, [selectedKeys, prompt, allModels])

  // ── Vote ───────────────────────────────────────────────────────────────────
  const castVote = useCallback(
    (winnerKey: string) => {
      setWinner(winnerKey)
    },
    [],
  )

  // ── Reveal ─────────────────────────────────────────────────────────────────
  const reveal = useCallback(() => {
    if (!winner) return
    setRevealAnim(true)
    // After animation, switch phase
    setTimeout(() => {
      setPhase('revealed')
      // Save to history
      const record: CompareRecord = {
        id: uuid(),
        timestamp: Date.now(),
        prompt: prompt.trim(),
        presetLabel: activePreset,
        slots: slots.map((s) => ({
          modelKey: s.modelKey,
          modelId: s.modelId,
          providerLabel: s.providerLabel,
          anonLabel: s.anonLabel,
          text: s.text,
          elapsedMs: s.endTime && s.startTime ? s.endTime - s.startTime : 0,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cost: s.cost,
        })),
        winner,
      }
      const updated = [record, ...history].slice(0, 100)
      setHistory(updated)
      saveHistory(updated)
    }, 600)
  }, [winner, prompt, activePreset, slots, history])

  // ── Reset ──────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setPhase('setup')
    setSlots([])
    setWinner(null)
    setRevealAnim(false)
  }, [])

  // ── Clear history ──────────────────────────────────────────────────────────
  const clearHistory = useCallback(() => {
    setHistory([])
    saveHistory([])
  }, [])

  // ── No providers fallback ──────────────────────────────────────────────────
  if (modelsLoaded && allModels.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6">
        <div className="rounded-card border border-line bg-surface p-6 text-center max-w-md">
          <div className="text-[13px] font-medium text-ink mb-2">
            {modelsError ? '模型加载失败' : '未找到可用模型'}
          </div>
          <p className="text-[12px] text-ink-dim mb-3">
            {modelsError
              ? modelsError
              : '请先在设置页面配置至少一个 AI 服务商，添加 API Key 后即可开始盲测。'}
          </p>
          <button
            className="rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors"
            onClick={() => {
              // Navigate to settings — dispatch a custom event that the shell listens for
              window.dispatchEvent(new CustomEvent('iris-navigate', { detail: { page: 'settings' } }))
            }}
          >
            前往设置
          </button>
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const allDone = slots.length > 0 && slots.every((s) => s.status === 'done' || s.status === 'error')
  const hasAnyDone = slots.some((s) => s.status === 'done')

  return (
    <div className="flex h-full bg-bg text-ink overflow-hidden">
      {/* ── Main content ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-y-auto p-4 gap-4">
        {/* ── Page header ─────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[13px] font-semibold text-ink">模型盲测</h1>
            <p className="text-[11px] text-ink-muted mt-0.5">
              选择 2-4 个模型，输入同一 Prompt，匿名对比输出质量后投票评选
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`rounded-input px-2.5 py-1 text-[11px] transition-colors ${
                showHistory
                  ? 'bg-primary text-white'
                  : 'border border-line bg-surface text-ink-dim hover:text-ink'
              }`}
              onClick={() => setShowHistory(!showHistory)}
            >
              {showHistory ? '关闭统计' : '历史 & 排名'}
            </button>
            {phase !== 'setup' && (
              <button
                className="rounded-input border border-line bg-surface px-2.5 py-1 text-[11px] text-ink-dim hover:text-ink transition-colors"
                onClick={reset}
              >
                新一轮
              </button>
            )}
          </div>
        </div>

        {/* ── Setup panel ─────────────────────────────────────── */}
        {phase === 'setup' && (
          <div className="rounded-card border border-line bg-surface p-3 space-y-3">
            {/* Model selection */}
            <div>
              <div className="text-[12px] font-medium text-ink mb-1.5">
                选择模型（{selectedKeys.size}/4）
              </div>
              {!modelsLoaded ? (
                <div className="text-[11px] text-ink-muted">加载模型列表...</div>
              ) : (
                <div className="space-y-2">
                  {modelGroups.map((g) => (
                    <div key={g.providerId}>
                      <div className="text-[11px] text-ink-muted mb-1">{g.providerLabel}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {g.items.map((m) => {
                          const key = `${m.providerId}|${m.modelId}`
                          const selected = selectedKeys.has(key)
                          return (
                            <button
                              key={key}
                              className={`rounded-input px-2 py-1 text-[11px] transition-colors border ${
                                selected
                                  ? 'border-primary/60 bg-primary/10 text-primary'
                                  : 'border-line bg-editor text-ink-dim hover:text-ink hover:border-primary/30'
                              } ${!selected && selectedKeys.size >= 4 ? 'opacity-40 cursor-not-allowed' : ''}`}
                              onClick={() => toggleModel(key)}
                              disabled={!selected && selectedKeys.size >= 4}
                            >
                              {m.modelId}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Preset prompts */}
            <div>
              <div className="text-[12px] font-medium text-ink mb-1.5">预设场景</div>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className={`rounded-input px-2 py-1 text-[11px] transition-colors border ${
                      activePreset === p.label
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'border-line bg-editor text-ink-dim hover:text-ink'
                    }`}
                    onClick={() => {
                      if (activePreset === p.label) {
                        setActivePreset(null)
                        setPrompt('')
                      } else {
                        setActivePreset(p.label)
                        setPrompt(p.prompt)
                      }
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt input */}
            <div>
              <div className="text-[12px] font-medium text-ink mb-1.5">测试 Prompt</div>
              <textarea
                className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60 resize-none"
                rows={4}
                placeholder="输入要发送给所有模型的 Prompt..."
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setActivePreset(null)
                }}
              />
            </div>

            {/* Start button */}
            <div className="flex justify-end">
              <button
                className="rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors disabled:opacity-40"
                disabled={selectedKeys.size < 2 || !prompt.trim()}
                onClick={startTest}
              >
                开始盲测
              </button>
            </div>
          </div>
        )}

        {/* ── Side-by-side results ────────────────────────────── */}
        {phase !== 'setup' && slots.length > 0 && (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }}
          >
            {slots.map((slot, idx) => (
              <div
                key={idx}
                className={`rounded-card border bg-surface p-3 flex flex-col gap-2 transition-all duration-500 ${
                  revealAnim ? 'scale-[0.98] opacity-80' : ''
                } ${
                  phase === 'revealed' && winner === slot.modelKey
                    ? 'border-primary ring-1 ring-primary/30'
                    : phase === 'voting' && winner === slot.modelKey
                      ? 'border-primary/60'
                      : 'border-line'
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-ink">{slot.anonLabel}</span>
                  <span className="text-[11px] text-ink-muted">
                    {slot.status === 'pending' && '等待中...'}
                    {slot.status === 'streaming' && (
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        生成中
                      </span>
                    )}
                    {slot.status === 'done' &&
                      slot.endTime &&
                      fmtMs(slot.endTime - slot.startTime)}
                    {slot.status === 'error' && (
                      <span className="text-failed">出错</span>
                    )}
                  </span>
                </div>

                {/* Revealed model name */}
                {phase === 'revealed' && (
                  <div
                    className={`text-[11px] font-medium transition-all duration-500 ${
                      revealAnim ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'
                    } ${winner === slot.modelKey ? 'text-primary' : 'text-ink-dim'}`}
                  >
                    {slot.providerLabel} / {slot.modelId}
                    {winner === slot.modelKey && ' ★'}
                  </div>
                )}

                {/* Response text */}
                <div className="flex-1 overflow-y-auto max-h-[50vh] rounded-input bg-editor p-2">
                  {slot.text ? (
                    <pre className="text-[11px] text-ink whitespace-pre-wrap break-words font-[inherit] leading-relaxed">
                      {slot.text}
                    </pre>
                  ) : slot.status === 'error' ? (
                    <div className="text-[11px] text-failed">{slot.error}</div>
                  ) : (
                    <div className="text-[11px] text-ink-muted">
                      {slot.status === 'pending' ? '等待开始...' : ''}
                    </div>
                  )}
                </div>

                {/* Stats row */}
                {(slot.status === 'done' || phase === 'revealed') && (
                  <div className="flex gap-3 text-[11px] text-ink-muted">
                    {slot.endTime && slot.startTime && (
                      <span>耗时 {fmtMs(slot.endTime - slot.startTime)}</span>
                    )}
                    {slot.outputTokens > 0 && <span>{fmtTokens(slot.outputTokens)} tokens</span>}
                    {phase === 'revealed' && slot.cost > 0 && <span>{fmtCost(slot.cost)}</span>}
                  </div>
                )}

                {/* Vote button (in voting phase) */}
                {phase === 'voting' && slot.status === 'done' && (
                  <button
                    className={`rounded-input px-2 py-1 text-[11px] transition-colors ${
                      winner === slot.modelKey
                        ? 'bg-primary text-white'
                        : 'border border-line text-ink-dim hover:border-primary/40 hover:text-ink'
                    }`}
                    onClick={() => castVote(slot.modelKey)}
                  >
                    {winner === slot.modelKey ? '已选为最佳' : '选为最佳'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Voting controls ─────────────────────────────────── */}
        {phase === 'voting' && allDone && (
          <div className="rounded-card border border-line bg-surface p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-ink-dim">
                  {hasAnyDone ? '所有模型已完成生成' : '部分模型出错'}，请选出最佳回复
                </span>
                <button
                  className={`rounded-input px-2 py-1 text-[11px] transition-colors ${
                    winner === 'tie'
                      ? 'bg-primary text-white'
                      : 'border border-line text-ink-dim hover:text-ink'
                  }`}
                  onClick={() => castVote('tie')}
                >
                  平局
                </button>
              </div>
              <button
                className="rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors disabled:opacity-40"
                disabled={!winner}
                onClick={reveal}
              >
                揭晓结果
              </button>
            </div>
          </div>
        )}

        {/* ── Revealed summary ────────────────────────────────── */}
        {phase === 'revealed' && (
          <div className="rounded-card border border-line bg-surface p-3 space-y-2">
            <div className="text-[12px] font-medium text-ink">结果揭晓</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${slots.length}, 1fr)` }}>
              {slots.map((slot, idx) => (
                <div
                  key={idx}
                  className={`rounded-input p-2 text-center ${
                    winner === slot.modelKey
                      ? 'bg-primary/10 border border-primary/30'
                      : winner === 'tie'
                        ? 'bg-editor border border-line'
                        : 'bg-editor border border-line opacity-60'
                  }`}
                >
                  <div className="text-[11px] text-ink-muted">{slot.anonLabel}</div>
                  <div className="text-[12px] font-medium text-ink mt-0.5">
                    {slot.modelId}
                  </div>
                  <div className="text-[11px] text-ink-muted mt-0.5">{slot.providerLabel}</div>
                  {winner === slot.modelKey && (
                    <div className="text-[11px] text-primary font-medium mt-1">Winner</div>
                  )}
                  {winner === 'tie' && (
                    <div className="text-[11px] text-ink-dim mt-1">平局</div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-1">
              <button
                className="rounded-input bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors"
                onClick={reset}
              >
                再来一轮
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── History & Stats sidebar ───────────────────────────── */}
      {showHistory && (
        <div className="w-72 border-l border-line bg-surface flex flex-col overflow-y-auto">
          {/* ELO Rankings */}
          <div className="p-3 border-b border-line">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-medium text-ink">ELO 排名</span>
              {history.length > 0 && (
                <button
                  className="text-[11px] text-ink-muted hover:text-failed transition-colors"
                  onClick={clearHistory}
                >
                  清空
                </button>
              )}
            </div>
            {stats.length === 0 ? (
              <div className="text-[11px] text-ink-muted">暂无数据，完成首次盲测后自动统计</div>
            ) : (
              <div className="space-y-1.5">
                {stats.map((s, i) => (
                  <div
                    key={s.modelKey}
                    className="rounded-input bg-editor p-2 flex items-start gap-2"
                  >
                    <span
                      className={`text-[12px] font-bold min-w-[18px] ${
                        i === 0 ? 'text-primary' : 'text-ink-muted'
                      }`}
                    >
                      #{i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-ink truncate" title={s.modelId}>
                        {s.modelId}
                      </div>
                      <div className="text-[11px] text-ink-muted truncate">{s.providerLabel}</div>
                      <div className="flex gap-2 mt-0.5 text-[11px] text-ink-muted">
                        <span>ELO {s.elo}</span>
                        <span>
                          {s.wins}W/{s.losses}L/{s.ties}T
                        </span>
                      </div>
                      <div className="flex gap-2 text-[11px] text-ink-muted">
                        <span>胜率 {(s.winRate * 100).toFixed(0)}%</span>
                        {s.avgTimeMs > 0 && <span>均耗时 {fmtMs(s.avgTimeMs)}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent history */}
          <div className="p-3 flex-1">
            <div className="text-[12px] font-medium text-ink mb-2">
              历史记录（{history.length}）
            </div>
            {history.length === 0 ? (
              <div className="text-[11px] text-ink-muted">暂无记录</div>
            ) : (
              <div className="space-y-2">
                {history.slice(0, 20).map((r) => (
                  <div
                    key={r.id}
                    className="rounded-input bg-editor p-2 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-ink-muted">
                        {new Date(r.timestamp).toLocaleDateString('zh-CN', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {r.presetLabel && (
                        <span className="text-[11px] text-primary/80">{r.presetLabel}</span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink truncate" title={r.prompt}>
                      {r.prompt.slice(0, 60)}
                      {r.prompt.length > 60 ? '...' : ''}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {r.slots.map((s, si) => {
                        const isWinner = r.winner === s.modelKey
                        const isTie = r.winner === 'tie'
                        return (
                          <span
                            key={si}
                            className={`inline-block rounded px-1 py-0.5 text-[10px] ${
                              isWinner
                                ? 'bg-primary/15 text-primary'
                                : isTie
                                  ? 'bg-editor text-ink-dim border border-line'
                                  : 'bg-editor text-ink-muted'
                            }`}
                            title={`${s.providerLabel} / ${s.modelId}`}
                          >
                            {s.modelId.length > 16 ? s.modelId.slice(0, 14) + '..' : s.modelId}
                            {isWinner && ' ★'}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
