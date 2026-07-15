// Webhook 事件管理页面 — 出站 webhook 端点配置 + HMAC 签名 + 投递日志。
// 前端 localStorage 持久化，fetch() 投递。
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Chip, StatusDot } from '../components/ui'
import type { ChipTone } from '../components/ui'



// ── Constants ────────────────────────────────────────────────────────────────

const LS_WEBHOOKS = 'iris-webhooks'
const LS_LOGS = 'iris-webhook-logs'
const MAX_LOGS = 200

const EVENT_TYPES = [
  { key: 'task.created', label: '任务创建' },
  { key: 'task.completed', label: '任务完成' },
  { key: 'task.failed', label: '任务失败' },
  { key: 'chat.message', label: '新聊天消息' },
  { key: 'research.complete', label: '深度研究完成' },
  { key: 'schedule.fired', label: '定时任务执行' },
  { key: 'kb.paper_added', label: '知识库新论文' },
] as const

type EventKey = (typeof EVENT_TYPES)[number]['key']

const EVENT_TONES: Record<string, ChipTone> = {
  'task.created': 'sky',
  'task.completed': 'done',
  'task.failed': 'failed',
  'chat.message': 'primary',
  'research.complete': 'lavender',
  'schedule.fired': 'gold',
  'kb.paper_added': 'mint',
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Webhook {
  id: string
  name: string
  url: string
  secret: string
  events: EventKey[]
  active: boolean
  createdAt: number
  deliveryCount: number
  successCount: number
  lastStatus: 'success' | 'failed' | 'pending' | null
}

interface DeliveryLog {
  id: string
  webhookId: string
  webhookName: string
  event: string
  url: string
  status: number | null
  success: boolean
  elapsed: number
  timestamp: number
  requestBody: string
  responseBody: string
  error?: string
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function loadWebhooks(): Webhook[] {
  try {
    return JSON.parse(localStorage.getItem(LS_WEBHOOKS) || '[]')
  } catch {
    return []
  }
}

function saveWebhooks(list: Webhook[]) {
  localStorage.setItem(LS_WEBHOOKS, JSON.stringify(list))
}

function loadLogs(): DeliveryLog[] {
  try {
    return JSON.parse(localStorage.getItem(LS_LOGS) || '[]')
  } catch {
    return []
  }
}

function saveLogs(logs: DeliveryLog[]) {
  localStorage.setItem(LS_LOGS, JSON.stringify(logs.slice(0, MAX_LOGS)))
}

// ── Secret generation ────────────────────────────────────────────────────────

function generateSecret(): string {
  return (
    crypto.randomUUID().replace(/-/g, '') +
    crypto.randomUUID().replace(/-/g, '')
  )
}

// ── HMAC delivery ────────────────────────────────────────────────────────────

async function deliverWebhook(
  webhook: Webhook,
  event: string,
  data: unknown,
): Promise<DeliveryLog> {
  const id = crypto.randomUUID()
  const payload = JSON.stringify({
    event,
    timestamp: Date.now(),
    data,
    delivery_id: id,
  })

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhook.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const start = performance.now()
  let status: number | null = null
  let success = false
  let responseBody = ''
  let error: string | undefined

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Iris-Signature': `sha256=${hexSig}`,
        'X-Iris-Event': event,
        'X-Iris-Delivery': id,
        'User-Agent': 'Iris-Webhook/1.0',
      },
      body: payload,
    })
    status = res.status
    success = res.ok
    try {
      responseBody = await res.text()
    } catch {
      responseBody = ''
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const elapsed = Math.round(performance.now() - start)

  return {
    id,
    webhookId: webhook.id,
    webhookName: webhook.name,
    event,
    url: webhook.url,
    status,
    success,
    elapsed,
    timestamp: Date.now(),
    requestBody: payload,
    responseBody,
    error,
  }
}

// ── Tab type ─────────────────────────────────────────────────────────────────

type Tab = 'webhooks' | 'logs'

// ── Component ────────────────────────────────────────────────────────────────

export default function Webhooks() {
  const [webhooks, setWebhooks] = useState<Webhook[]>(loadWebhooks)
  const [logs, setLogs] = useState<DeliveryLog[]>(loadLogs)
  const [tab, setTab] = useState<Tab>('webhooks')

  // dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formSecret, setFormSecret] = useState('')
  const [formEvents, setFormEvents] = useState<Set<EventKey>>(new Set())
  const [formActive, setFormActive] = useState(true)

  // delivery states
  const [delivering, setDelivering] = useState<string | null>(null)

  // log filters
  const [logEventFilter, setLogEventFilter] = useState<string>('')
  const [logStatusFilter, setLogStatusFilter] = useState<
    '' | 'success' | 'failed'
  >('')

  // expanded log entries
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())

  // confirm delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // persist on change
  useEffect(() => {
    saveWebhooks(webhooks)
  }, [webhooks])

  useEffect(() => {
    saveLogs(logs)
  }, [logs])

  // ── dialog helpers ───────────────────────────────────────────────────────

  const resetForm = useCallback(() => {
    setFormName('')
    setFormUrl('')
    setFormSecret(generateSecret())
    setFormEvents(new Set())
    setFormActive(true)
    setEditId(null)
  }, [])

  const openCreate = useCallback(() => {
    resetForm()
    setDialogOpen(true)
  }, [resetForm])

  const openEdit = useCallback((wh: Webhook) => {
    setEditId(wh.id)
    setFormName(wh.name)
    setFormUrl(wh.url)
    setFormSecret(wh.secret)
    setFormEvents(new Set(wh.events))
    setFormActive(wh.active)
    setDialogOpen(true)
  }, [])

  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    setEditId(null)
  }, [])

  const toggleEvent = useCallback((key: EventKey) => {
    setFormEvents((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleSave = useCallback(() => {
    if (!formName.trim() || !formUrl.trim()) return
    if (editId) {
      setWebhooks((prev) =>
        prev.map((wh) =>
          wh.id === editId
            ? {
                ...wh,
                name: formName.trim(),
                url: formUrl.trim(),
                secret: formSecret,
                events: Array.from(formEvents) as EventKey[],
                active: formActive,
              }
            : wh,
        ),
      )
    } else {
      const newWh: Webhook = {
        id: crypto.randomUUID(),
        name: formName.trim(),
        url: formUrl.trim(),
        secret: formSecret,
        events: Array.from(formEvents) as EventKey[],
        active: formActive,
        createdAt: Date.now(),
        deliveryCount: 0,
        successCount: 0,
        lastStatus: null,
      }
      setWebhooks((prev) => [newWh, ...prev])
    }
    closeDialog()
  }, [editId, formName, formUrl, formSecret, formEvents, formActive, closeDialog])

  // ── delivery ─────────────────────────────────────────────────────────────

  const sendTest = useCallback(
    async (wh: Webhook) => {
      setDelivering(wh.id)
      try {
        const log = await deliverWebhook(wh, 'ping', {
          message: 'Iris webhook test delivery',
        })
        setLogs((prev) => [log, ...prev].slice(0, MAX_LOGS))
        setWebhooks((prev) =>
          prev.map((w) =>
            w.id === wh.id
              ? {
                  ...w,
                  deliveryCount: w.deliveryCount + 1,
                  successCount: log.success
                    ? w.successCount + 1
                    : w.successCount,
                  lastStatus: log.success ? 'success' : 'failed',
                }
              : w,
          ),
        )
      } catch {
        // network error already captured in log
      } finally {
        setDelivering(null)
      }
    },
    [],
  )

  const handleDelete = useCallback((id: string) => {
    setWebhooks((prev) => prev.filter((wh) => wh.id !== id))
    setConfirmDeleteId(null)
  }, [])

  const toggleActive = useCallback((id: string) => {
    setWebhooks((prev) =>
      prev.map((wh) =>
        wh.id === id ? { ...wh, active: !wh.active } : wh,
      ),
    )
  }, [])

  // ── filtered logs ────────────────────────────────────────────────────────

  const filteredLogs = useMemo(() => {
    let list = logs
    if (logEventFilter) {
      list = list.filter((l) => l.event === logEventFilter)
    }
    if (logStatusFilter === 'success') {
      list = list.filter((l) => l.success)
    } else if (logStatusFilter === 'failed') {
      list = list.filter((l) => !l.success)
    }
    return list
  }, [logs, logEventFilter, logStatusFilter])

  const toggleLogExpand = useCallback((id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── stats ────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const total = webhooks.length
    const active = webhooks.filter((w) => w.active).length
    const totalDeliveries = webhooks.reduce(
      (s, w) => s + w.deliveryCount,
      0,
    )
    return { total, active, totalDeliveries }
  }, [webhooks])

  // ── mask secret ──────────────────────────────────────────────────────────

  const maskSecret = (s: string) => {
    if (s.length <= 8) return '********'
    return s.slice(0, 4) + '****' + s.slice(-4)
  }

  // ── format timestamp ────────────────────────────────────────────────────

  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return (
      d.toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
      }) +
      ' ' +
      d.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    )
  }

  const successRate = (wh: Webhook) => {
    if (wh.deliveryCount === 0) return '--'
    return Math.round((wh.successCount / wh.deliveryCount) * 100) + '%'
  }

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* ── Header ── */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-ink">Webhook 事件</h1>
          <p className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">
            配置出站 Webhook 端点，在系统事件发生时自动 POST 通知。每个请求包含
            HMAC-SHA256 签名供目标验证。
          </p>
          {/* 统计 */}
          <div className="mt-3 flex flex-wrap gap-3">
            <span className="rounded-btn border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted">
              端点 <span className="font-semibold text-ink">{stats.total}</span>
            </span>
            <span className="rounded-btn border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted">
              活跃{' '}
              <span className="font-semibold text-ink">{stats.active}</span>
            </span>
            <span className="rounded-btn border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted">
              投递总数{' '}
              <span className="font-semibold text-ink">
                {stats.totalDeliveries}
              </span>
            </span>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="mb-4 flex items-center gap-4 border-b border-line">
          <button
            className={`pb-2 text-[13px] font-medium transition-colors ${
              tab === 'webhooks'
                ? 'text-primary border-b-2 border-primary'
                : 'text-ink-muted hover:text-ink'
            }`}
            onClick={() => setTab('webhooks')}
          >
            Webhook 列表
          </button>
          <button
            className={`pb-2 text-[13px] font-medium transition-colors ${
              tab === 'logs'
                ? 'text-primary border-b-2 border-primary'
                : 'text-ink-muted hover:text-ink'
            }`}
            onClick={() => setTab('logs')}
          >
            投递日志
            {logs.length > 0 && (
              <span className="ml-1.5 text-[10.5px] text-ink-dim font-normal">
                ({logs.length})
              </span>
            )}
          </button>
          <span className="flex-1" />
          {tab === 'webhooks' && (
            <button
              onClick={openCreate}
              className="rounded-btn bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors mb-2"
            >
              + 新建 Webhook
            </button>
          )}
        </div>

        {/* ═══════════ Webhook list tab ═══════════ */}
        {tab === 'webhooks' && (
          <section>
            {webhooks.length === 0 && (
              <div className="rounded-card border border-line bg-surface p-8 text-center">
                <p className="text-[13px] text-ink-dim mb-3">
                  暂无配置的 Webhook 端点
                </p>
                <button
                  onClick={openCreate}
                  className="rounded-btn bg-primary px-4 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors"
                >
                  创建第一个 Webhook
                </button>
              </div>
            )}

            {webhooks.length > 0 && (
              <div className="grid gap-3">
                {webhooks.map((wh) => (
                  <div
                    key={wh.id}
                    className="rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong"
                  >
                    {/* top row: name + status */}
                    <div className="flex items-center gap-3 mb-2">
                      <StatusDot
                        status={wh.active ? 'done' : 'idle'}
                        size={7}
                      />
                      <h3 className="text-[13px] font-semibold text-ink truncate flex-1 min-w-0">
                        {wh.name}
                      </h3>
                      {wh.lastStatus && (
                        <Chip
                          tone={
                            wh.lastStatus === 'success'
                              ? 'done'
                              : wh.lastStatus === 'failed'
                                ? 'failed'
                                : 'gold'
                          }
                        >
                          {wh.lastStatus === 'success'
                            ? '最近成功'
                            : wh.lastStatus === 'failed'
                              ? '最近失败'
                              : '待投递'}
                        </Chip>
                      )}
                    </div>

                    {/* url + secret */}
                    <div className="mb-2">
                      <p className="text-[11px] text-ink-muted truncate font-mono">
                        POST {wh.url}
                      </p>
                      <p className="text-[11px] text-ink-faint mt-0.5">
                        Secret: {maskSecret(wh.secret)}
                      </p>
                    </div>

                    {/* subscribed events */}
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {wh.events.length === 0 && (
                        <span className="text-[10.5px] text-ink-faint">
                          未订阅任何事件
                        </span>
                      )}
                      {wh.events.map((ev) => (
                        <Chip key={ev} tone={EVENT_TONES[ev] || 'neutral'}>
                          {ev}
                        </Chip>
                      ))}
                    </div>

                    {/* stats row */}
                    <div className="flex items-center gap-4 text-[11px] text-ink-dim mb-3">
                      <span>
                        投递{' '}
                        <span className="text-ink font-medium">
                          {wh.deliveryCount}
                        </span>{' '}
                        次
                      </span>
                      <span>
                        成功率{' '}
                        <span className="text-ink font-medium">
                          {successRate(wh)}
                        </span>
                      </span>
                    </div>

                    {/* actions */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => sendTest(wh)}
                        disabled={delivering === wh.id}
                        className="rounded-btn border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink hover:border-line-strong transition-colors disabled:opacity-40"
                      >
                        {delivering === wh.id ? '发送中...' : '发送测试'}
                      </button>
                      <button
                        onClick={() => toggleActive(wh.id)}
                        className={`rounded-btn border px-2.5 py-1 text-[11px] transition-colors ${
                          wh.active
                            ? 'border-[#10a37f40] bg-[#10a37f1a] text-done hover:bg-[#10a37f28]'
                            : 'border-line bg-surface-2 text-ink-dim hover:border-line-strong'
                        }`}
                      >
                        {wh.active ? '已启用' : '已禁用'}
                      </button>
                      <span className="flex-1" />
                      <button
                        onClick={() => openEdit(wh)}
                        className="text-[11px] text-ink-dim hover:text-primary transition-colors"
                      >
                        编辑
                      </button>
                      {confirmDeleteId === wh.id ? (
                        <span className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleDelete(wh.id)}
                            className="text-[11px] text-failed hover:text-failed/80 transition-colors"
                          >
                            确认删除
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[11px] text-ink-dim hover:text-ink transition-colors"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(wh.id)}
                          className="text-[11px] text-ink-dim hover:text-failed transition-colors"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ═══════════ Delivery logs tab ═══════════ */}
        {tab === 'logs' && (
          <section>
            {/* filters */}
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <select
                value={logEventFilter}
                onChange={(e) => setLogEventFilter(e.target.value)}
                className="rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60"
              >
                <option value="">全部事件</option>
                {EVENT_TYPES.map((ev) => (
                  <option key={ev.key} value={ev.key}>
                    {ev.key}
                  </option>
                ))}
                <option value="ping">ping</option>
              </select>
              <select
                value={logStatusFilter}
                onChange={(e) =>
                  setLogStatusFilter(
                    e.target.value as '' | 'success' | 'failed',
                  )
                }
                className="rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60"
              >
                <option value="">全部状态</option>
                <option value="success">成功</option>
                <option value="failed">失败</option>
              </select>
              <span className="flex-1" />
              {logs.length > 0 && (
                <button
                  onClick={() => {
                    setLogs([])
                    setExpandedLogIds(new Set())
                  }}
                  className="text-[11px] text-ink-dim hover:text-failed transition-colors"
                >
                  清空日志
                </button>
              )}
            </div>

            {filteredLogs.length === 0 && (
              <p className="text-[12px] text-ink-dim py-6 text-center">
                暂无投递记录
              </p>
            )}

            {filteredLogs.length > 0 && (
              <div className="space-y-2">
                {filteredLogs.map((log) => {
                  const expanded = expandedLogIds.has(log.id)
                  return (
                    <div
                      key={log.id}
                      className="rounded-card border border-line bg-surface transition-colors"
                    >
                      {/* summary row */}
                      <button
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                        onClick={() => toggleLogExpand(log.id)}
                      >
                        <StatusDot
                          status={log.success ? 'done' : 'failed'}
                          size={6}
                        />
                        <span className="text-[11px] text-ink-dim w-[110px] flex-shrink-0">
                          {fmtTime(log.timestamp)}
                        </span>
                        <Chip tone={EVENT_TONES[log.event] || 'neutral'}>
                          {log.event}
                        </Chip>
                        <span className="text-[11px] text-ink-muted truncate flex-1 min-w-0 font-mono">
                          {log.url}
                        </span>
                        <span
                          className={`text-[11px] font-mono flex-shrink-0 ${
                            log.success ? 'text-done' : 'text-failed'
                          }`}
                        >
                          {log.status ?? 'ERR'}
                        </span>
                        <span className="text-[10.5px] text-ink-faint flex-shrink-0 w-[50px] text-right">
                          {log.elapsed}ms
                        </span>
                        <span className="text-[10px] text-ink-faint flex-shrink-0">
                          {expanded ? '▲' : '▼'}
                        </span>
                      </button>

                      {/* expanded detail */}
                      {expanded && (
                        <div className="border-t border-line px-3 py-3 space-y-2">
                          <div>
                            <p className="text-[10.5px] text-ink-dim mb-1 font-medium">
                              Webhook: {log.webhookName}
                            </p>
                            <p className="text-[10.5px] text-ink-dim mb-1">
                              Delivery ID:{' '}
                              <span className="font-mono text-ink text-[10px]">
                                {log.id}
                              </span>
                            </p>
                            {log.error && (
                              <p className="text-[10.5px] text-failed">
                                Error: {log.error}
                              </p>
                            )}
                          </div>
                          <div>
                            <p className="text-[10.5px] text-ink-dim mb-1 font-medium">
                              Request Body
                            </p>
                            <pre className="text-[10px] text-ink-muted bg-editor rounded-input p-2 overflow-x-auto max-h-[120px] overflow-y-auto font-mono leading-relaxed">
                              {(() => {
                                try {
                                  return JSON.stringify(
                                    JSON.parse(log.requestBody),
                                    null,
                                    2,
                                  )
                                } catch {
                                  return log.requestBody
                                }
                              })()}
                            </pre>
                          </div>
                          {log.responseBody && (
                            <div>
                              <p className="text-[10.5px] text-ink-dim mb-1 font-medium">
                                Response Body
                              </p>
                              <pre className="text-[10px] text-ink-muted bg-editor rounded-input p-2 overflow-x-auto max-h-[120px] overflow-y-auto font-mono leading-relaxed">
                                {(() => {
                                  try {
                                    return JSON.stringify(
                                      JSON.parse(log.responseBody),
                                      null,
                                      2,
                                    )
                                  } catch {
                                    return log.responseBody
                                  }
                                })()}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {/* ═══════════ Create / Edit dialog ═══════════ */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={closeDialog}
          />
          {/* panel */}
          <div className="relative z-10 w-full max-w-lg rounded-card border border-line bg-bg p-5 shadow-xl mx-4 max-h-[85vh] overflow-y-auto">
            <h2 className="text-[14px] font-semibold text-ink mb-4">
              {editId ? '编辑 Webhook' : '新建 Webhook'}
            </h2>

            {/* name */}
            <label className="block mb-3">
              <span className="text-[11px] text-ink-dim mb-1 block">名称</span>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="例如: CI/CD 通知"
                className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60"
              />
            </label>

            {/* url */}
            <label className="block mb-3">
              <span className="text-[11px] text-ink-dim mb-1 block">
                目标 URL (POST)
              </span>
              <input
                type="url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://example.com/webhook"
                className="w-full rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60 font-mono"
              />
            </label>

            {/* secret */}
            <label className="block mb-3">
              <span className="text-[11px] text-ink-dim mb-1 block">
                Secret (HMAC-SHA256 签名密钥)
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={formSecret}
                  onChange={(e) => setFormSecret(e.target.value)}
                  className="flex-1 rounded-input border border-line bg-editor px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary/60 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setFormSecret(generateSecret())}
                  className="rounded-btn border border-line bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-muted hover:text-ink hover:border-line-strong transition-colors flex-shrink-0"
                >
                  重新生成
                </button>
              </div>
            </label>

            {/* content type (read-only) */}
            <div className="mb-3">
              <span className="text-[11px] text-ink-dim mb-1 block">
                Content-Type
              </span>
              <span className="text-[12px] text-ink-muted font-mono">
                application/json
              </span>
            </div>

            {/* event subscriptions */}
            <div className="mb-4">
              <span className="text-[11px] text-ink-dim mb-2 block">
                订阅事件
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {EVENT_TYPES.map((ev) => (
                  <label
                    key={ev.key}
                    className="flex items-center gap-2 rounded-input px-2 py-1.5 cursor-pointer hover:bg-surface-2 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={formEvents.has(ev.key)}
                      onChange={() => toggleEvent(ev.key)}
                      className="accent-primary w-3.5 h-3.5 rounded"
                    />
                    <span className="text-[11px] text-ink">{ev.key}</span>
                    <span className="text-[10px] text-ink-faint">
                      {ev.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* active toggle */}
            <div className="mb-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setFormActive(!formActive)}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  formActive ? 'bg-primary' : 'bg-surface-2 border border-line'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
                    formActive ? 'translate-x-4' : ''
                  }`}
                />
              </button>
              <span className="text-[12px] text-ink">
                {formActive ? '启用' : '禁用'}
              </span>
            </div>

            {/* actions */}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={closeDialog}
                className="rounded-btn border border-line bg-transparent px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink hover:bg-surface-2 hover:border-line-strong transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!formName.trim() || !formUrl.trim()}
                className="rounded-btn bg-primary px-3 py-1.5 text-[12px] text-white hover:bg-primary-hover transition-colors disabled:opacity-40"
              >
                {editId ? '保存更改' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
