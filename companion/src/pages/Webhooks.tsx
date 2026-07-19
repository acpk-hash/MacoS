import { useState } from 'react'

/* ---------- Types ---------- */

interface WebhookEntry {
  id: string
  name: string
  url: string
  events: string[]
  enabled: boolean
  lastStatus: number | null
}

interface DeliveryLog {
  id: string
  event: string
  timestamp: string
  status: number
  responseMs: number
}

/* ---------- Mock data ---------- */

const MOCK_WEBHOOKS: WebhookEntry[] = [
  {
    id: 'wh-1',
    name: '任务通知',
    url: 'https://api.example.com/hooks/task-notify',
    events: ['task.created', 'task.completed'],
    enabled: true,
    lastStatus: 200,
  },
  {
    id: 'wh-2',
    name: 'Slack 集成',
    url: 'https://hooks.slack.com/services/T0X.../B0Y.../abc123',
    events: ['chat.message', 'agent.event'],
    enabled: true,
    lastStatus: 200,
  },
  {
    id: 'wh-3',
    name: '数据同步',
    url: 'https://internal.corp.net/webhook/sync-receiver',
    events: ['sync.connected', 'task.completed'],
    enabled: false,
    lastStatus: null,
  },
]

const MOCK_DELIVERIES: DeliveryLog[] = [
  { id: 'd1', event: 'task.completed', timestamp: '2026-07-16 14:23:08', status: 200, responseMs: 124 },
  { id: 'd2', event: 'chat.message', timestamp: '2026-07-16 14:21:55', status: 200, responseMs: 89 },
  { id: 'd3', event: 'agent.event', timestamp: '2026-07-16 14:18:30', status: 500, responseMs: 2034 },
  { id: 'd4', event: 'task.created', timestamp: '2026-07-16 14:15:12', status: 200, responseMs: 156 },
  { id: 'd5', event: 'sync.connected', timestamp: '2026-07-16 13:59:44', status: 200, responseMs: 67 },
  { id: 'd6', event: 'task.completed', timestamp: '2026-07-16 13:42:01', status: 500, responseMs: 5012 },
]

const ALL_EVENTS = ['task.created', 'task.completed', 'chat.message', 'agent.event', 'sync.connected']

/* ---------- Icons ---------- */

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-ink-dim transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-dim shrink-0 mt-0.5">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-done shrink-0">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  )
}

/* ---------- Sub-components ---------- */

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative w-10 h-[22px] rounded-full transition-colors ${
        enabled ? 'bg-[#10a37f]' : 'bg-surface-2 border border-line'
      }`}
    >
      <span
        className={`absolute top-0.5 w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform ${
          enabled ? 'left-[20px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function EventBadge({ event }: { event: string }) {
  const badgeMap: Record<string, string> = {
    'task.created': 'badge-mint',
    'task.completed': 'badge-sky',
    'chat.message': 'badge-gold',
    'agent.event': 'badge-coral',
    'sync.connected': 'badge-mint',
  }
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeMap[event] ?? 'bg-surface-2 text-ink-muted'}`}>
      {event}
    </span>
  )
}

function StatusBadge({ status }: { status: number | null }) {
  if (status === null) {
    return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-2 text-ink-faint">--</span>
  }
  const ok = status >= 200 && status < 300
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${ok ? 'bg-[#10a37f]/10 text-done' : 'bg-[#d0342c]/10 text-failed'}`}>
      {status}
    </span>
  )
}

function WebhookCard({
  hook,
  onToggle,
}: {
  hook: WebhookEntry
  onToggle: () => void
}) {
  const truncatedUrl = hook.url.length > 40 ? hook.url.slice(0, 38) + '...' : hook.url

  return (
    <div className="bg-editor rounded-xl border border-line p-4 flex flex-col gap-3 animate-in">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <LinkIcon />
          <h3 className="text-sm font-semibold text-ink truncate">{hook.name}</h3>
        </div>
        <Toggle enabled={hook.enabled} onToggle={onToggle} />
      </div>

      <code className="text-[11px] font-mono text-ink-muted bg-surface-2 rounded-lg px-2.5 py-1.5 break-all">
        {truncatedUrl}
      </code>

      <div className="flex flex-wrap gap-1.5">
        {hook.events.map((ev) => (
          <EventBadge key={ev} event={ev} />
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-ink-faint">最近状态</span>
        <StatusBadge status={hook.lastStatus} />
      </div>
    </div>
  )
}

/* ---------- Main Component ---------- */

export default function Webhooks() {
  const [webhooks, setWebhooks] = useState(MOCK_WEBHOOKS)
  const [formOpen, setFormOpen] = useState(false)
  const [formName, setFormName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formSecret, setFormSecret] = useState('')
  const [formEvents, setFormEvents] = useState<string[]>([])

  function toggleWebhook(id: string) {
    setWebhooks((prev) =>
      prev.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w))
    )
  }

  function toggleFormEvent(event: string) {
    setFormEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    )
  }

  function handleCreate() {
    if (!formName.trim() || !formUrl.trim() || formEvents.length === 0) return
    const newHook: WebhookEntry = {
      id: `wh-${Date.now()}`,
      name: formName.trim(),
      url: formUrl.trim(),
      events: formEvents,
      enabled: true,
      lastStatus: null,
    }
    setWebhooks((prev) => [newHook, ...prev])
    setFormName('')
    setFormUrl('')
    setFormSecret('')
    setFormEvents([])
    setFormOpen(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3">
        <h1 className="text-lg font-bold text-ink">Webhook</h1>
        <p className="text-xs text-ink-muted mt-0.5">事件推送与外部集成</p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 flex flex-col gap-4">
        {/* Active webhooks */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">活跃 Webhook</p>
            <span className="text-[10px] text-ink-faint font-mono">{webhooks.filter((w) => w.enabled).length} 个启用</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {webhooks.map((hook) => (
              <WebhookCard key={hook.id} hook={hook} onToggle={() => toggleWebhook(hook.id)} />
            ))}
          </div>
        </section>

        {/* New webhook form */}
        <section>
          <button
            onClick={() => setFormOpen(!formOpen)}
            className="w-full flex items-center justify-between px-1 mb-2"
          >
            <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide">新建 Webhook</p>
            <ChevronIcon open={formOpen} />
          </button>

          {formOpen && (
            <div className="bg-editor rounded-xl border border-line p-4 flex flex-col gap-3 animate-in">
              <div>
                <label className="text-xs text-ink-muted block mb-1.5">名称</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="我的 Webhook"
                  className="w-full h-10 px-3 rounded-xl border border-line bg-bg text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
                />
              </div>

              <div>
                <label className="text-xs text-ink-muted block mb-1.5">URL</label>
                <input
                  type="url"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  className="w-full h-10 px-3 rounded-xl border border-line bg-bg text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition font-mono"
                />
              </div>

              <div>
                <label className="text-xs text-ink-muted block mb-1.5">Secret Key (HMAC-SHA256)</label>
                <input
                  type="password"
                  value={formSecret}
                  onChange={(e) => setFormSecret(e.target.value)}
                  placeholder="whsec_..."
                  className="w-full h-10 px-3 rounded-xl border border-line bg-bg text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition font-mono"
                />
              </div>

              <div>
                <label className="text-xs text-ink-muted block mb-2">订阅事件</label>
                <div className="flex flex-wrap gap-2">
                  {ALL_EVENTS.map((ev) => {
                    const selected = formEvents.includes(ev)
                    return (
                      <button
                        key={ev}
                        onClick={() => toggleFormEvent(ev)}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                          selected
                            ? 'bg-primary text-white border-primary'
                            : 'bg-surface-2 text-ink-muted border-line active:bg-line'
                        }`}
                      >
                        {ev}
                      </button>
                    )
                  })}
                </div>
              </div>

              <button
                onClick={handleCreate}
                disabled={!formName.trim() || !formUrl.trim() || formEvents.length === 0}
                className="w-full h-11 rounded-xl bg-primary text-white text-sm font-semibold active:opacity-80 disabled:opacity-40 transition-opacity mt-1"
              >
                创建 Webhook
              </button>
            </div>
          )}
        </section>

        {/* Delivery log */}
        <section>
          <p className="text-xs font-semibold text-ink-dim uppercase tracking-wide mb-2 px-1">投递日志</p>
          <div className="bg-editor rounded-xl border border-line divide-y divide-line-soft overflow-hidden">
            {MOCK_DELIVERIES.map((d) => {
              const ok = d.status >= 200 && d.status < 300
              return (
                <div
                  key={d.id}
                  className={`px-4 py-3 flex items-center gap-3 ${
                    !ok ? 'border-l-2 border-l-[#d0342c]' : ''
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <EventBadge event={d.event} />
                    </div>
                    <p className="text-[10px] text-ink-faint font-mono mt-1">{d.timestamp}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-ink-faint font-mono">{d.responseMs}ms</span>
                    <StatusBadge status={d.status} />
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Security note */}
        <div className="bg-[#10a37f]/5 rounded-xl border border-[#10a37f]/20 p-4 flex gap-3 items-start animate-in">
          <ShieldIcon />
          <div>
            <p className="text-sm font-medium text-ink">签名验证</p>
            <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
              所有推送均使用 HMAC-SHA256 签名验证。每次请求的 Header 中包含{' '}
              <code className="text-[11px] font-mono bg-surface-2 px-1 py-0.5 rounded">X-Webhook-Signature</code>{' '}
              字段，请在接收端校验签名以确保请求来源可信。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
