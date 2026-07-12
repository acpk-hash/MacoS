// Commerce store — 「跨境电商」板块：选品 → 利润 → 洞察 → 出图 → listing
// 五模块流水线的状态中心。一个产品 = 一个「项目」，全量入本 store 并持久化
// localStorage，模块间互相引用同项目数据形成闭环；导航离开不丢任何状态。
//
// 通道复用（后端签名已只读核对 src-tauri/src/studio.rs，2026-07-12）：
//  - 模型文本：chat_sessions_create(title,model) + chat_send(session_id,
//    user_content, attachments, model, provider_id)，流式事件 studio-event
//    （delta/done/error 按 session_id 路由）。与 officeStore 相同的
//    「隐藏会话 + 独立监听」模式，但支持多槽位并发（选品/评论/洞察/listing
//    可同时在跑），完成后删除隐藏会话不污染聊天历史。
//  - 生图：image_generate(prompt, model, size, n, provider_id) -> Vec<row id>；
//    记录 id 归属到项目画廊，媒体本体与图像板块共用 gen_media 库
//    （studioStore.media），占位/完成由 main.tsx 注册的全局监听维护。
//
// 可信度约定（UI 三种标签的事实来源）：
//  - AI 分析辅助：runResearch / runReview / runInsightSummary / runListing
//  - 本地硬计算：computeProfit / analyzeTerms（纯前端，无模型参与）
//  - 用户真实数据：CSV 上传与评论粘贴的原始内容
import { create } from 'zustand'
import type { AggModel } from './studioStore'
import { useStudioStore } from './studioStore'
import { useTaskRegistry } from './taskRegistryStore'

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

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'id-' + Math.random().toString(36).slice(2)
}

interface RawAggModel {
  kind: string
  provider_id: string
  provider_label: string
  model_id: string
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

// ── CSV 解析（自写极简 RFC4180：引号 / 转义引号 / 引号内换行） ────────────────

export function parseCommerceCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// ── 搜索词报告：字段映射 + 聚合 + 本地决策规则引擎（自研版，纯前端硬计算） ──

export interface TermStat {
  term: string
  impressions: number
  clicks: number
  spend: number
  orders: number
  sales: number
  ctr: number | null
  cvr: number | null
  acos: number | null
}

export type TermAction =
  | 'negative_candidate'
  | 'scale_up'
  | 'reduce_bid'
  | 'hold_test'
  | 'observe'

export const TERM_ACTION_LABEL: Record<TermAction, string> = {
  negative_candidate: '否词候选',
  scale_up: '放量候选',
  reduce_bid: '降价控本',
  hold_test: '维持测试',
  observe: '继续观察',
}

export interface TermDecision extends TermStat {
  action: TermAction
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

/** 可配置阈值（自研规则引擎；点击/花费为绝对值，band 为相对基准的比例）。 */
export const TERM_RULES = {
  minClicks: 8, // 低于此点击不下强结论
  minClicksScale: 12, // 放量至少要求的点击样本
  minSpend: 10, // 花费低于此值不重点关注
  highSpendNoOrder: 15, // 花费超此值仍零单 → 否词候选
  nearBand: 0.15, // 与基准 CVR 差 ±15% 内视为接近平均
  highBand: 0.2, // 高于基准 20% 以上 → 明显偏好
  lowBand: 0.2, // 低于基准 20% 以上 → 明显偏差
}

function toNum(raw: string | undefined): number {
  if (!raw) return 0
  const cleaned = raw.replace(/[$€£¥,\s"]/g, '').replace(/%$/, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

/** 列名匹配（中英文常见叫法，宽松包含式）。 */
function findCol(headers: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h))
    if (i >= 0) return i
  }
  return -1
}

export interface TermAnalysis {
  stats: TermStat[]
  baselineCvr: number | null
  decisions: TermDecision[]
  note: string
}

export function analyzeTerms(
  grid: string[][],
  targetAcosPct: number,
): TermAnalysis | { error: string } {
  if (grid.length < 2) return { error: 'CSV 行数不足（需要表头 + 数据行）' }
  const headers = grid[0].map((h) => h.trim().toLowerCase())
  const iTerm = findCol(headers, [/客户搜索词|customer search term/, /搜索词|search term/])
  const iImp = findCol(headers, [/展示量|impressions/])
  const iClk = findCol(headers, [/点击量|clicks/])
  const iSpend = findCol(headers, [/花费|spend|cost/])
  const iOrd = findCol(headers, [/订单|orders/])
  const iSales = findCol(headers, [/销售额|sales/])
  if (iTerm < 0 || iClk < 0 || iSpend < 0) {
    return {
      error:
        '无法识别必需列（客户搜索词/点击量/花费）。请上传卖家后台导出的搜索词报告 CSV（支持中英文表头）。',
    }
  }

  // 按标准化搜索词聚合（折叠空格/统一小写，脏字符变体合并）。
  const byTerm = new Map<string, TermStat>()
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r]
    const rawTerm = (row[iTerm] ?? '').replace(/\s+/g, ' ').trim()
    if (!rawTerm) continue
    const key = rawTerm.toLowerCase()
    let s = byTerm.get(key)
    if (!s) {
      s = {
        term: key,
        impressions: 0,
        clicks: 0,
        spend: 0,
        orders: 0,
        sales: 0,
        ctr: null,
        cvr: null,
        acos: null,
      }
      byTerm.set(key, s)
    }
    if (iImp >= 0) s.impressions += toNum(row[iImp])
    s.clicks += toNum(row[iClk])
    s.spend += toNum(row[iSpend])
    if (iOrd >= 0) s.orders += toNum(row[iOrd])
    if (iSales >= 0) s.sales += toNum(row[iSales])
  }

  let stats = [...byTerm.values()]
  let note = ''
  const MAX_TERMS = 1000
  if (stats.length > MAX_TERMS) {
    stats = stats.sort((a, b) => b.spend - a.spend).slice(0, MAX_TERMS)
    note = '搜索词超过 ' + MAX_TERMS + ' 个，仅保留花费最高的前 ' + MAX_TERMS + ' 个。'
  }
  for (const s of stats) {
    s.ctr = s.impressions > 0 ? s.clicks / s.impressions : null
    s.cvr = s.clicks > 0 ? s.orders / s.clicks : null
    s.acos = s.sales > 0 ? s.spend / s.sales : null
  }

  const totClicks = stats.reduce((a, s) => a + s.clicks, 0)
  const totOrders = stats.reduce((a, s) => a + s.orders, 0)
  const baselineCvr = totClicks > 0 && iOrd >= 0 ? totOrders / totClicks : null
  const target = targetAcosPct > 0 ? targetAcosPct / 100 : null
  const R = TERM_RULES

  const decisions: TermDecision[] = stats.map((s) => {
    const conf: TermDecision['confidence'] =
      s.clicks >= 15 && s.orders > 0 ? 'high' : s.clicks >= R.minClicks ? 'medium' : 'low'
    const mk = (action: TermAction, reason: string): TermDecision => ({
      ...s,
      action,
      confidence: conf,
      reason,
    })
    const pct = (v: number) => (v * 100).toFixed(1) + '%'
    const usd = (v: number) => '$' + v.toFixed(2)

    if (s.clicks < R.minClicks && s.spend < R.minSpend) {
      return mk('observe', '样本不足（点击 ' + s.clicks + '、花费 ' + usd(s.spend) + '），暂不下结论')
    }
    if (s.orders === 0 && iOrd >= 0) {
      if (s.spend >= R.highSpendNoOrder) {
        return mk(
          'negative_candidate',
          '高花费零单：' + usd(s.spend) + '、' + s.clicks + ' 次点击仍 0 单；否定前先确认词与产品相关性',
        )
      }
      if (s.spend >= R.minSpend) {
        return mk('reduce_bid', '零单且花费 ' + usd(s.spend) + ' 已起量，先降 bid 控成本')
      }
      return mk('observe', '零单但花费尚小，继续观察')
    }
    if (baselineCvr == null || baselineCvr <= 0 || s.cvr == null) {
      return mk('hold_test', '缺少订单/转化基准，仅维持测试')
    }
    const overTarget = target != null && s.acos != null && s.acos > target
    if (s.cvr >= baselineCvr * (1 + R.highBand)) {
      if (target != null && s.acos != null && s.acos > target * 1.15) {
        return mk(
          'reduce_bid',
          'CVR ' + pct(s.cvr) + ' 高于基准，但 ACOS ' + pct(s.acos) + ' 明显超目标（' + targetAcosPct + '%），先压成本再谈放量',
        )
      }
      if (s.clicks >= R.minClicksScale) {
        return mk('scale_up', '高转化：CVR ' + pct(s.cvr) + ' vs 基准 ' + pct(baselineCvr) + '，建议放量/转精准')
      }
      return mk('hold_test', '转化优秀（CVR ' + pct(s.cvr) + '）但点击样本 ' + s.clicks + ' 偏薄，小步提 bid 加厚样本')
    }
    if (s.cvr <= baselineCvr * (1 - R.lowBand)) {
      if (overTarget) {
        return mk(
          'reduce_bid',
          'CVR ' + pct(s.cvr) + ' 低于基准 ' + pct(baselineCvr) + ' 且 ACOS 超目标，降 bid；若词义不相关可升级为否词',
        )
      }
      return mk('observe', '转化低于基准但成本尚可控，观察；关注是否 listing 承接问题')
    }
    if (overTarget && s.acos != null) {
      return mk('reduce_bid', '转化接近基准但 ACOS ' + pct(s.acos) + ' 超目标 ' + targetAcosPct + '%，先降 bid')
    }
    return mk('hold_test', '表现接近基准（CVR ' + pct(s.cvr) + '），维持或小幅测试')
  })

  const order: Record<TermAction, number> = {
    negative_candidate: 0,
    scale_up: 1,
    reduce_bid: 2,
    hold_test: 3,
    observe: 4,
  }
  decisions.sort((a, b) => order[a.action] - order[b.action] || b.spend - a.spend)
  return { stats, baselineCvr, decisions, note }
}

// ── 利润测算（本地硬计算，纯函数；公式在 UI 明示） ───────────────────────────

export interface ProfitInput {
  /** 售价（站点货币） */
  price: number
  /** 采购成本 */
  cogs: number
  /** 头程运费 / 件 */
  freight: number
  /** FBA 配送费 / 件 */
  fbaFee: number
  /** 平台佣金 %（referral fee） */
  commissionPct: number
  /** 退货率 % */
  returnRatePct: number
  /** 广告费占销售额 %（TACOS） */
  adPct: number
  /** 其他固定费用 / 件（仓储/包装等） */
  otherFee: number
}

export interface ProfitResult {
  commission: number
  grossProfit: number
  grossMarginPct: number
  adCost: number
  returnLoss: number
  netProfit: number
  netMarginPct: number
  /** 盈亏平衡 ACOS %（广告吃掉全部毛利前的上限） */
  breakevenAcosPct: number | null
  /** 盈亏平衡 ROAS（= 1 / 盈亏平衡 ACOS） */
  breakevenRoas: number | null
}

/**
 * 公式（全部本地计算）：
 *  佣金 = 售价 × 佣金%
 *  毛利 = 售价 − 采购 − 头程 − FBA − 佣金 − 其他
 *  广告费 = 售价 × 广告%
 *  退货损耗 = 退货率% × (采购 + 头程 + FBA)   ← 按退回件整件报废保守估计
 *  净利 = 毛利 − 广告费 − 退货损耗
 *  盈亏平衡 ACOS = (毛利 − 退货损耗) / 售价
 */
export function computeProfit(x: ProfitInput): ProfitResult {
  const commission = x.price * (x.commissionPct / 100)
  const grossProfit = x.price - x.cogs - x.freight - x.fbaFee - commission - x.otherFee
  const adCost = x.price * (x.adPct / 100)
  const returnLoss = (x.returnRatePct / 100) * (x.cogs + x.freight + x.fbaFee)
  const netProfit = grossProfit - adCost - returnLoss
  const beAcos = x.price > 0 ? (grossProfit - returnLoss) / x.price : null
  return {
    commission,
    grossProfit,
    grossMarginPct: x.price > 0 ? (grossProfit / x.price) * 100 : 0,
    adCost,
    returnLoss,
    netProfit,
    netMarginPct: x.price > 0 ? (netProfit / x.price) * 100 : 0,
    breakevenAcosPct: beAcos != null ? beAcos * 100 : null,
    breakevenRoas: beAcos != null && beAcos > 0 ? 1 / beAcos : null,
  }
}

/** 常见站点佣金档位预设（美/欧常见类目费率，仅供快速填入）。 */
export const COMMISSION_PRESETS: { label: string; pct: number }[] = [
  { label: '大多数类目（美/欧 15%）', pct: 15 },
  { label: '消费电子（8%）', pct: 8 },
  { label: '个护美妆低价档（8%）', pct: 8 },
  { label: '服装（美 17%）', pct: 17 },
  { label: '珠宝饰品（20%）', pct: 20 },
  { label: '大家电（12%）', pct: 12 },
]

// ── 项目数据模型 ─────────────────────────────────────────────────────────────

export interface ResearchState {
  category: string
  competitorNotes: string
  extraNotes: string
  /** 模块①产出：Markdown 报告（AI 分析辅助）。 */
  report: string
}

export interface ProfitScenario {
  id: string
  name: string
  input: ProfitInput
  createdAt: number
}

export interface InsightState {
  csvFileName: string
  targetAcosPct: number
  baselineCvr: number | null
  decisions: TermDecision[]
  analysisNote: string
  /** 模块③可选产出：模型洞察摘要（AI 分析辅助）。 */
  aiSummary: string
  reviewText: string
  /** 模块③产出：评论六维痛点报告（AI 分析辅助）。 */
  reviewReport: string
}

export interface ImageWorkState {
  typeId: string
  templateIds: string[]
  vars: Record<string, string>
  size: string
  /** 项目画廊：归属本项目的 gen_media 记录 id。 */
  mediaIds: string[]
}

export interface ListingState {
  productInfo: string
  keywords: string
  audience: string
  marketplace: string
  useResearch: boolean
  useInsight: boolean
  useImages: boolean
  /** 模块⑤产出：完整 listing 文案 Markdown（AI 分析辅助）。 */
  output: string
}

export const DEFAULT_PROFIT_INPUT: ProfitInput = {
  price: 29.99,
  cogs: 6,
  freight: 2.5,
  fbaFee: 5.5,
  commissionPct: 15,
  returnRatePct: 5,
  adPct: 15,
  otherFee: 0.5,
}

export interface CommerceProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  research: ResearchState
  /** 利润测算的当前表单（未保存为方案也持久，导航不丢）。 */
  profitDraft?: ProfitInput
  profitScenarios: ProfitScenario[]
  insight: InsightState
  images: ImageWorkState
  listing: ListingState
}

export function defaultProject(name: string): CommerceProject {
  const now = Date.now()
  return {
    id: uuid(),
    name,
    createdAt: now,
    updatedAt: now,
    research: { category: '', competitorNotes: '', extraNotes: '', report: '' },
    profitDraft: { ...DEFAULT_PROFIT_INPUT },
    profitScenarios: [],
    insight: {
      csvFileName: '',
      targetAcosPct: 30,
      baselineCvr: null,
      decisions: [],
      analysisNote: '',
      aiSummary: '',
      reviewText: '',
      reviewReport: '',
    },
    images: { typeId: '', templateIds: [], vars: {}, size: '1024x1024', mediaIds: [] },
    listing: {
      productInfo: '',
      keywords: '',
      audience: '',
      marketplace: '美国站',
      useResearch: true,
      useInsight: true,
      useImages: true,
      output: '',
    },
  }
}

// ── localStorage 持久化 ──────────────────────────────────────────────────────

const LS_KEY = 'agentboard.commerce.v1'

interface PersistShape {
  projects: CommerceProject[]
  activeProjectId: string | null
}

function loadPersisted(): PersistShape {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return { projects: [], activeProjectId: null }
    const p = JSON.parse(raw) as PersistShape
    if (!Array.isArray(p.projects)) return { projects: [], activeProjectId: null }
    return { projects: p.projects, activeProjectId: p.activeProjectId ?? null }
  } catch {
    return { projects: [], activeProjectId: null }
  }
}

function savePersisted(projects: CommerceProject[], activeProjectId: string | null) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify({ projects, activeProjectId }))
  } catch {
    // 存储不可用时仅保留内存态。
  }
}

// ── 隐藏会话 + 多槽位并发的一问一答（studio-event 独立监听） ─────────────────

export type ChatSlot = 'research' | 'review' | 'insight' | 'listing'

export interface SlotState {
  status: 'idle' | 'running' | 'done' | 'error'
  streamText: string
  error: string | null
}

const idleSlot = (): SlotState => ({ status: 'idle', streamText: '', error: null })

interface PendingRun {
  slot: ChatSlot
  projectId: string
  sessionId: string
  buf: string
  resolve: (text: string) => void
  reject: (err: Error) => void
}

/** 在途请求（按隐藏会话 id 路由；模块级，跨页面导航存活）。 */
const pendingRuns = new Map<string, PendingRun>()
let listenerReady = false

async function ensureListener(): Promise<void> {
  if (listenerReady || !isTauri) return
  listenerReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<StudioEvent>('studio-event', (evt) => {
      const p = evt.payload
      if (!p.session_id) return
      const run = pendingRuns.get(p.session_id)
      if (!run) return
      switch (p.type) {
        case 'delta':
          run.buf += p.text ?? ''
          useCommerceStore.setState((s) => ({
            slots: { ...s.slots, [run.slot]: { ...s.slots[run.slot], streamText: run.buf } },
          }))
          break
        case 'done':
          pendingRuns.delete(p.session_id)
          // 用量落库：done 事件若带 usage 字段，写入 pi_usage 表统一统计。
          if (p.input_tokens || p.output_tokens) {
            const model = useCommerceStore.getState().chatModel
            void tauriInvoke<void>('pi_usage_insert_manual', {
              sessionId: p.session_id,
              model: 'commerce:' + model,
              provider: 'studio',
              input: p.input_tokens ?? 0,
              output: p.output_tokens ?? 0,
              cacheRead: p.cache_read_tokens ?? 0,
              cacheWrite: p.cache_write_tokens ?? 0,
              cost: p.cost ?? 0,
            }).catch(() => {})
          }
          run.resolve(p.text || run.buf)
          break
        case 'error':
          pendingRuns.delete(p.session_id)
          run.reject(new Error(p.message ?? '生成出错'))
          break
        default:
          break
      }
    })
  } catch (err) {
    listenerReady = false
    console.warn('[commerceStore] failed to register studio-event listener:', err)
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

interface CommerceStore {
  /** 当前步骤（1~5；放 store 里导航离开再回来不丢）。 */
  activeStep: number
  setActiveStep: (n: number) => void

  // 模型选择（chat 与 image 各一套）
  aggModels: AggModel[]
  modelsLoaded: boolean
  chatModel: string
  chatProviderId: string | null
  imageModel: string
  imageProviderId: string | null
  loadModels: () => Promise<void>
  setChatModelSel: (providerId: string, modelId: string) => void
  setImageModelSel: (providerId: string, modelId: string) => void

  // 项目
  projects: CommerceProject[]
  activeProjectId: string | null
  createProject: (name?: string) => void
  selectProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  deleteProject: (id: string) => void
  /** 对指定项目做局部修改并持久化（并发回写安全的唯一入口）。 */
  patchProject: (id: string, patch: (p: CommerceProject) => Partial<CommerceProject>) => void

  // AI 槽位（选品报告 / 评论分析 / 搜索词摘要 / listing）
  slots: Record<ChatSlot, SlotState>
  runSlot: (
    slot: ChatSlot,
    taskTitle: string,
    prompt: string,
    apply: (p: CommerceProject, text: string) => Partial<CommerceProject>,
  ) => Promise<void>
  stopSlot: (slot: ChatSlot) => Promise<void>

  // ③ 搜索词 CSV（本地硬计算）
  loadTermsCsv: (fileName: string, text: string) => void

  // ④ 出图批量任务
  imagesGenerating: boolean
  imagesProgress: string
  generateImages: (
    jobs: { name: string; prompt: string }[],
    size: string,
  ) => Promise<void>
}

export const useCommerceStore = create<CommerceStore>((set, get) => {
  const persisted = typeof window === 'undefined'
    ? { projects: [], activeProjectId: null }
    : loadPersisted()

  function persist() {
    const s = get()
    savePersisted(s.projects, s.activeProjectId)
  }

  return {
    activeStep: 1,
    setActiveStep: (n) => set({ activeStep: n }),

    aggModels: [],
    modelsLoaded: false,
    chatModel: '',
    chatProviderId: null,
    imageModel: '',
    imageProviderId: null,

    loadModels: async () => {
      if (!isTauri) return
      try {
        const raw = await tauriInvoke<RawAggModel[]>('providers_models')
        const aggModels: AggModel[] = raw.map((m) => ({
          providerId: m.provider_id,
          providerLabel: m.provider_label,
          modelId: m.model_id,
          kind: m.kind ?? 'chat',
        }))
        set((s) => {
          const chats = aggModels.filter((m) => m.kind === 'chat')
          const images = aggModels.filter((m) => m.kind === 'image')
          const keepChat = chats.find((m) => m.modelId === s.chatModel)
          const keepImg = images.find((m) => m.modelId === s.imageModel)
          const chat = keepChat ?? chats.find((m) => m.modelId === 'gpt-5.5') ?? chats[0]
          const img = keepImg ?? images[0]
          return {
            aggModels,
            modelsLoaded: true,
            chatModel: chat?.modelId ?? '',
            chatProviderId: chat?.providerId ?? null,
            imageModel: img?.modelId ?? '',
            imageProviderId: img?.providerId ?? null,
          }
        })
      } catch (e) {
        console.warn('[commerceStore] loadModels failed:', e)
        set({ modelsLoaded: true })
      }
    },

    setChatModelSel: (providerId, modelId) =>
      set({ chatProviderId: providerId, chatModel: modelId }),
    setImageModelSel: (providerId, modelId) =>
      set({ imageProviderId: providerId, imageModel: modelId }),

    projects: persisted.projects,
    activeProjectId: persisted.activeProjectId,

    createProject: (name) => {
      const n = (name ?? '').trim() || '未命名产品 ' + (get().projects.length + 1)
      const proj = defaultProject(n)
      set((s) => ({ projects: [proj, ...s.projects], activeProjectId: proj.id }))
      persist()
    },

    selectProject: (id) => {
      if (!get().projects.some((p) => p.id === id)) return
      set({ activeProjectId: id })
      persist()
    },

    renameProject: (id, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p,
        ),
      }))
      persist()
    },

    deleteProject: (id) => {
      set((s) => {
        const projects = s.projects.filter((p) => p.id !== id)
        return {
          projects,
          activeProjectId:
            s.activeProjectId === id ? projects[0]?.id ?? null : s.activeProjectId,
        }
      })
      persist()
    },

    patchProject: (id, patch) => {
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, ...patch(p), updatedAt: Date.now() } : p,
        ),
      }))
      persist()
    },

    // ── AI 槽位 ──────────────────────────────────────────────────

    slots: {
      research: idleSlot(),
      review: idleSlot(),
      insight: idleSlot(),
      listing: idleSlot(),
    },

    runSlot: async (slot, taskTitle, prompt, apply) => {
      if (!isTauri) {
        set((s) => ({
          slots: {
            ...s.slots,
            [slot]: { status: 'error', streamText: '', error: '模型调用仅在桌面应用内可用' },
          },
        }))
        return
      }
      if (get().slots[slot].status === 'running') return
      const projectId = get().activeProjectId
      if (!projectId) return
      const model = get().chatModel
      if (!model) {
        set((s) => ({
          slots: {
            ...s.slots,
            [slot]: { status: 'error', streamText: '', error: '尚未选择对话模型（请到设置配置服务商）' },
          },
        }))
        return
      }
      await ensureListener()

      set((s) => ({
        slots: { ...s.slots, [slot]: { status: 'running', streamText: '', error: null } },
      }))
      const taskId = 'commerce-' + slot + '-' + uuid()
      const reg = useTaskRegistry.getState()
      reg.registerTask({ id: taskId, module: 'commerce', title: taskTitle })

      let sessionId = ''
      try {
        // 每轮任务全新隐藏会话：上下文自包含；完成后删除，避免污染聊天历史。
        const row = await tauriInvoke<{ id: string }>('chat_sessions_create', {
          title: '[电商] ' + taskTitle,
          model,
        })
        sessionId = row.id

        const promise = new Promise<string>((resolve, reject) => {
          pendingRuns.set(sessionId, {
            slot,
            projectId,
            sessionId,
            buf: '',
            resolve,
            reject,
          })
        })
        await tauriInvoke<string>('chat_send', {
          sessionId,
          userContent: prompt,
          attachments: [],
          model,
          providerId: get().chatProviderId ?? null,
        })
        const text = await promise
        get().patchProject(projectId, (p) => apply(p, text))
        set((s) => ({
          slots: { ...s.slots, [slot]: { status: 'done', streamText: '', error: null } },
        }))
        reg.updateTask(taskId, { status: 'done' })
      } catch (e) {
        pendingRuns.delete(sessionId)
        set((s) => ({
          slots: {
            ...s.slots,
            [slot]: { status: 'error', streamText: '', error: String(e) },
          },
        }))
        reg.updateTask(taskId, { status: 'error', detail: String(e) })
      } finally {
        if (sessionId) {
          try {
            await tauriInvoke<void>('chat_sessions_delete', { sessionId })
          } catch {
            /* 清理失败不影响主流程 */
          }
        }
      }
    },

    stopSlot: async (slot) => {
      const run = [...pendingRuns.values()].find((r) => r.slot === slot)
      if (!run) return
      try {
        await tauriInvoke<void>('chat_stop', { sessionId: run.sessionId })
      } catch (e) {
        console.warn('[commerceStore] stopSlot failed:', e)
      }
    },

    // ── ③ 搜索词 CSV（本地硬计算，无模型参与） ───────────────────

    loadTermsCsv: (fileName, text) => {
      const projectId = get().activeProjectId
      if (!projectId) return
      const grid = parseCommerceCsv(text)
      const proj = get().projects.find((p) => p.id === projectId)
      const targetAcos = proj?.insight.targetAcosPct ?? 30
      const result = analyzeTerms(grid, targetAcos)
      if ('error' in result) {
        get().patchProject(projectId, (p) => ({
          insight: {
            ...p.insight,
            csvFileName: fileName,
            baselineCvr: null,
            decisions: [],
            analysisNote: result.error,
          },
        }))
        return
      }
      get().patchProject(projectId, (p) => ({
        insight: {
          ...p.insight,
          csvFileName: fileName,
          baselineCvr: result.baselineCvr,
          decisions: result.decisions,
          analysisNote: result.note,
          aiSummary: '',
        },
      }))
    },

    // ── ④ 出图批量任务（复用 image_generate 通道） ────────────────

    imagesGenerating: false,
    imagesProgress: '',

    generateImages: async (jobs, size) => {
      if (!isTauri || jobs.length === 0) return
      if (get().imagesGenerating) return
      const projectId = get().activeProjectId
      if (!projectId) return
      const model = get().imageModel
      if (!model) {
        set({ imagesProgress: '没有可用的图像模型（请到设置配置服务商）' })
        return
      }
      const providerId = get().imageProviderId

      set({ imagesGenerating: true, imagesProgress: '' })
      const taskId = 'commerce-images-' + uuid()
      const reg = useTaskRegistry.getState()
      reg.registerTask({
        id: taskId,
        module: 'commerce',
        title: '产品图生成 ×' + jobs.length,
      })

      const failed: string[] = []
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]
        const progress = '(' + (i + 1) + '/' + jobs.length + ') ' + job.name
        set({ imagesProgress: progress })
        reg.updateTask(taskId, { detail: progress })
        try {
          const ids = await tauriInvoke<string[]>('image_generate', {
            prompt: job.prompt,
            model,
            size,
            n: 1,
            providerId: providerId ?? null,
          })
          get().patchProject(projectId, (p) => ({
            images: { ...p.images, mediaIds: [...ids, ...p.images.mediaIds] },
          }))
        } catch (e) {
          failed.push(job.name + '：' + String(e))
        }
        // 让共享画廊尽快出现占位/结果。
        void useStudioStore.getState().loadMedia('image')
      }

      set({
        imagesGenerating: false,
        imagesProgress: failed.length ? '部分失败：' + failed.join('；') : '',
      })
      reg.updateTask(taskId, {
        status: failed.length ? 'error' : 'done',
        detail: failed.length ? failed.join('；') : '共 ' + jobs.length + ' 个模板已提交',
      })
    },
  }
})
