// agentHubStore — 「Agent」板块：编码会话工作流的本地存档与复用。
// 数据来源：piStore 在 agent_end（非 willRetry）定稿时把会话快照推到这里
// （见 piStore 的存档钩子），本 store 把 timeline 归纳成 WorkflowRecord：
//   - user 步骤存全文（也构成 fullPromptChain）
//   - assistant 步骤截 300 字摘要
//   - tool 步骤提炼 toolName + 目标（命令 / 文件路径）
// 同一会话多轮 agent_end 按 id upsert 同一条记录；localStorage 持久，
// 上限 200 条 LRU（最新在前，超出裁掉最旧）。纯前端，不触后端。
import { create } from 'zustand'
import type { PiSession, PiTimelineItem, PiUsage } from './piStore'

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type WorkflowStatus = 'done' | 'error' | 'running'

export interface WorkflowStep {
  kind: 'user' | 'assistant' | 'tool'
  /** user=全文；assistant=300 字摘要；tool=「toolName · 目标」提炼。 */
  summary: string
  toolName?: string
  /** tool 步骤命中的目标文件（edit/write/read 类）。 */
  path?: string
  /** tool 步骤执行的命令（bash/shell 类）。 */
  cmd?: string
}

export interface WorkflowUsage {
  input: number
  output: number
  cost: number
  turns: number
}

export interface WorkflowRecord {
  /** = pi 会话 id（同会话多轮更新同一条）。 */
  id: string
  /** 首条 user 消息截断。 */
  title: string
  cwd: string
  model: string
  createdAt: number
  finishedAt: number
  status: WorkflowStatus
  steps: WorkflowStep[]
  /** 按轮的 user 消息原文（复用的核心素材）。 */
  fullPromptChain: string[]
  usage?: WorkflowUsage
}

/** piStore 在 agent_end 定稿时推送的会话快照。 */
export interface SessionSnapshot {
  session: PiSession
  timeline: PiTimelineItem[]
  usage?: PiUsage
}

// ── 持久化 ────────────────────────────────────────────────────────────────────

const LS_KEY = 'iris.agenthub.workflows.v1'
const MAX_RECORDS = 200

function loadRecords(): WorkflowRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is WorkflowRecord =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as WorkflowRecord).id === 'string' &&
        typeof (r as WorkflowRecord).title === 'string' &&
        typeof (r as WorkflowRecord).cwd === 'string' &&
        Array.isArray((r as WorkflowRecord).steps) &&
        Array.isArray((r as WorkflowRecord).fullPromptChain),
    )
  } catch {
    return []
  }
}

function saveRecords(records: WorkflowRecord[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(records))
  } catch {
    /* localStorage 不可用/超限时仅内存生效 */
  }
}

// ── timeline → WorkflowRecord 归纳 ───────────────────────────────────────────

function clipText(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 单行化 + 截断（tool 摘要用）。 */
function clipOne(s: string, max: number): string {
  return clipText(s.replace(/\s+/g, ' '), max)
}

function argStr(args: unknown, ...keys: string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const o = args as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function toolStep(toolName: string, args: unknown): WorkflowStep {
  const cmd = argStr(args, 'command', 'cmd', 'script')
  const path = argStr(
    args,
    'path',
    'file_path',
    'filePath',
    'filename',
    'file',
    'absolute_path',
  )
  const target = cmd ?? path ?? argStr(args, 'pattern', 'query', 'url')
  const step: WorkflowStep = {
    kind: 'tool',
    toolName,
    summary: target ? `${toolName} · ${clipOne(target, 160)}` : toolName,
  }
  if (cmd) step.cmd = clipText(cmd, 500)
  else if (path) step.path = path
  return step
}

function buildRecord(snap: SessionSnapshot, prevCreatedAt?: number): WorkflowRecord {
  const { session, timeline, usage } = snap
  const steps: WorkflowStep[] = []
  const fullPromptChain: string[] = []

  for (const it of timeline) {
    if (it.kind === 'user') {
      const text = it.text.trim()
      if (!text) continue
      fullPromptChain.push(it.text)
      steps.push({ kind: 'user', summary: it.text })
    } else if (it.kind === 'assistant') {
      const text = it.text.trim()
      if (!text) continue
      steps.push({ kind: 'assistant', summary: clipText(text, 300) })
    } else if (it.kind === 'tool') {
      steps.push(toolStep(it.toolName, it.args))
    }
    // system 条目不进工作流。
  }

  const title =
    session.title !== '新会话'
      ? session.title
      : fullPromptChain[0]
        ? clipOne(fullPromptChain[0], 32)
        : '（空会话）'

  return {
    id: session.id,
    title,
    cwd: session.cwd,
    model: session.model,
    createdAt: prevCreatedAt ?? session.createdAt,
    finishedAt: Date.now(),
    status:
      session.status === 'done'
        ? 'done'
        : session.status === 'error'
          ? 'error'
          : 'running',
    steps,
    fullPromptChain,
    usage:
      usage && usage.turns > 0
        ? {
            input: usage.input,
            output: usage.output,
            cost: usage.cost,
            turns: usage.turns,
          }
        : undefined,
  }
}

// ── 导出 .md 渲染 ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  done: '已完成',
  error: '出错',
  running: '进行中',
}

const STEP_TAG: Record<WorkflowStep['kind'], string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

/** 工作流 → Markdown（标题 / 环境 / 逐步骤清单 / 各轮 prompt 原文）。 */
export function workflowToMarkdown(rec: WorkflowRecord): string {
  const lines: string[] = []
  lines.push(`# ${rec.title}`)
  lines.push('')
  lines.push('## 环境')
  lines.push('')
  lines.push(`- 状态：${STATUS_LABEL[rec.status]}`)
  lines.push(`- 模型：${rec.model || '（默认）'}`)
  lines.push(`- 目录：${rec.cwd}`)
  lines.push(`- 创建：${new Date(rec.createdAt).toLocaleString('zh-CN')}`)
  lines.push(`- 结束：${new Date(rec.finishedAt).toLocaleString('zh-CN')}`)
  if (rec.usage) {
    lines.push(
      `- 用量：输入 ${rec.usage.input} / 输出 ${rec.usage.output} tokens · ` +
        `${rec.usage.turns} 轮 · $${rec.usage.cost.toFixed(4)}`,
    )
  }
  lines.push('')
  lines.push('## 步骤清单')
  lines.push('')
  rec.steps.forEach((s, i) => {
    const summary =
      s.kind === 'user' ? clipOne(s.summary, 200) : s.summary.replace(/\s+/g, ' ')
    lines.push(`${i + 1}. **[${STEP_TAG[s.kind]}]** ${summary}`)
  })
  lines.push('')
  lines.push('## Prompt 链（逐轮原文）')
  rec.fullPromptChain.forEach((p, i) => {
    lines.push('')
    lines.push(`### 第 ${i + 1} 轮`)
    lines.push('')
    // 四反引号围栏，避免 prompt 内自带 ``` 破坏结构。
    lines.push('````text')
    lines.push(p)
    lines.push('````')
  })
  lines.push('')
  return lines.join('\n')
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AgentHubStore {
  /** 工作流存档，最新在前（LRU 上限 200）。 */
  records: WorkflowRecord[]
  /** piStore agent_end 定稿钩子入口：按会话 id upsert。 */
  archiveSession: (snap: SessionSnapshot) => void
  removeRecord: (id: string) => void
}

export const useAgentHubStore = create<AgentHubStore>((set) => ({
  records: loadRecords(),

  archiveSession: (snap) => {
    set((s) => {
      const prev = s.records.find((r) => r.id === snap.session.id)
      const rec = buildRecord(snap, prev?.createdAt)
      // 没有任何用户输入的会话不值得存档。
      if (rec.fullPromptChain.length === 0) return {}
      const records = [rec, ...s.records.filter((r) => r.id !== rec.id)].slice(
        0,
        MAX_RECORDS,
      )
      saveRecords(records)
      return { records }
    })
  },

  removeRecord: (id) => {
    set((s) => {
      const records = s.records.filter((r) => r.id !== id)
      saveRecords(records)
      return { records }
    })
  },
}))
