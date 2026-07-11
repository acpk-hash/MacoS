import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import Composer, { type ComposerHandle } from '../components/Composer'
import type { Attachment } from '../stores/studioStore'
import { Mascot } from '../components/ui'

// ── Environment guard ─────────────────────────────────────────────────────────

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

/** Open a URL in the system default browser (never inside the webview). */
async function openExternal(href: string) {
  try {
    await tauriInvoke('open_external_url', { url: href })
  } catch (e) {
    console.warn('[RemoteHermes] openExternal failed:', e)
  }
}

const HERMES_REPO = 'https://github.com/NousResearch/hermes-agent'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mirrors Rust hermes::HermesConfig. */
interface HermesConfig {
  configured: boolean
  base_url: string
  model: string
  enabled: boolean
  has_key: boolean
  key_mask: string
}

interface HermesEvent {
  type: string
  run_id?: string
  text?: string
  status?: string
  message?: string
}

/** 本地会话条目（仅内存——任务本体在远端 Hermes 上执行）。 */
interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  /** complete | streaming | stopped | error */
  status: string
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'm-' + Math.random().toString(36).slice(2)
}

// ── Markdown（深色，精简版 StudioChat 管线） ──────────────────────────────────

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight] as never

const mdComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-3 rounded-lg overflow-x-auto border border-line bg-[#0d1117] p-3 text-[13px] leading-relaxed">
      {children}
    </pre>
  ),
  code(props) {
    const { className, children } = props
    const isBlock = /language-/.test(className || '')
    if (!isBlock) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-surface-2 text-[0.85em] font-mono text-sky">
          {children}
        </code>
      )
    }
    return <code className={className}>{children}</code>
  },
  p: ({ children }) => <p className="my-2 leading-7">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-7">{children}</li>,
  h1: ({ children }) => <h1 className="text-xl font-semibold mt-4 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold mt-4 mb-2">{children}</h2>,
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-3 mb-1.5">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 my-2 text-ink-muted">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        if (href) {
          e.preventDefault()
          void openExternal(href)
        }
      }}
      className="text-sky underline underline-offset-2 cursor-pointer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-line" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-3 py-1.5 bg-surface text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-line px-3 py-1.5">{children}</td>,
}

const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] text-ink break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

// ── 部署说明卡片 ──────────────────────────────────────────────────────────────

function DeployGuide() {
  return (
    <div className="glass rounded-card p-4 text-xs text-ink-muted leading-relaxed space-y-2 max-w-xl">
      <p className="text-sm font-semibold text-ink">什么是远端 Hermes？</p>
      <p>
        Hermes Agent 是 Nous Research 开源（MIT）的远端 agent：部署在你自己的服务器上，
        自带记忆与 skills，并暴露 OpenAI 兼容 API。在这里发送的任务会
        <span className="text-ink"> 在远端服务器上处理</span>，本机只负责收发。
      </p>
      <ol className="list-decimal pl-5 space-y-1">
        <li>
          准备一台服务器（内存 ≥ 1–2GB），获取仓库：
          <button
            onClick={() => void openExternal(HERMES_REPO)}
            className="text-sky underline underline-offset-2 ml-1"
          >
            github.com/NousResearch/hermes-agent
          </button>
        </li>
        <li>
          按仓库 README 一键安装或用 Docker 启动，并开启 API 服务器
          （OpenAI 兼容，默认端口 <code className="px-1 rounded bg-surface-2 font-mono">8642</code>）。
        </li>
        <li>
          回到本应用「设置 → 远端处理 (Hermes)」，填端点 URL（如
          <code className="px-1 rounded bg-surface-2 font-mono">http://your-host:8642/v1</code>
          ）与可选的 API Key，测试连接通过即可在此委派任务。
        </li>
      </ol>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RemoteHermes() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<HermesConfig | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | null>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  const loadConfig = async () => {
    try {
      const cfg = await tauriInvoke<HermesConfig>('hermes_config_get')
      setConfig(cfg)
    } catch (e) {
      console.warn('[RemoteHermes] load config failed:', e)
      setConfig({
        configured: false,
        base_url: '',
        model: '',
        enabled: false,
        has_key: false,
        key_mask: '',
      })
    }
  }

  // 初始加载 + 流式事件订阅（deltas 追加到最后一条 streaming 回复上）。
  useEffect(() => {
    if (!isTauri) return
    void loadConfig()
    let unlisten: (() => void) | null = null
    let disposed = false
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const un = await listen<HermesEvent>('hermes-event', (evt) => {
          const p = evt.payload
          if (p.type !== 'delta' || !p.text) return
          setMessages((msgs) => {
            const out = [...msgs]
            for (let i = out.length - 1; i >= 0; i--) {
              if (out[i].role === 'assistant' && out[i].status === 'streaming') {
                out[i] = { ...out[i], content: out[i].content + p.text }
                return out
              }
            }
            return msgs
          })
        })
        if (disposed) un()
        else unlisten = un
      } catch (e) {
        console.warn('[RemoteHermes] listen failed:', e)
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 自动滚到底部。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  /** 把最后一条 streaming 回复置为终态。 */
  const finishStreaming = (status: string, text?: string) => {
    setMessages((msgs) => {
      const out = [...msgs]
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === 'assistant' && out[i].status === 'streaming') {
          out[i] = {
            ...out[i],
            status,
            content: text !== undefined ? text : out[i].content,
          }
          return out
        }
      }
      return msgs
    })
  }

  const handleSend = async (content: string, attachments: Attachment[]) => {
    if (busy) return
    setMessages((msgs) => [
      ...msgs,
      { id: uid(), role: 'user', content, attachments, status: 'complete' },
      { id: uid(), role: 'assistant', content: '', status: 'streaming' },
    ])
    setBusy(true)
    try {
      const text = await tauriInvoke<string>('hermes_send', {
        prompt: content,
        attachments,
      })
      finishStreaming('complete', text)
    } catch (e) {
      finishStreaming('error', String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    try {
      await tauriInvoke<void>('hermes_stop')
    } catch (e) {
      console.warn('[RemoteHermes] stop failed:', e)
    }
  }

  // ── 页面级拖放（与工作台对话一致：整页都是拖放目标） ────────────────────────
  const dragHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }
  const onDrop = (e: React.DragEvent) => {
    dragDepth.current = 0
    setDropActive(false)
    if (!dragHasFiles(e)) return
    if (e.defaultPrevented) return // Composer 自己的拖放区已处理
    e.preventDefault()
    composerRef.current?.addFiles(Array.from(e.dataTransfer?.files ?? []))
  }

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
      </div>
    )
  }

  const ready = !!config && config.configured && config.enabled
  const hasMessages = messages.length > 0

  return (
    <div
      className="relative flex flex-col h-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropActive && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px] pointer-events-none">
          <div className="px-10 py-8 rounded-pop border-2 border-dashed border-lavender/70 bg-surface/90 text-center">
            <div className="text-3xl mb-2" aria-hidden="true">📂</div>
            <p className="text-[14px] text-ink font-medium">
              拖放文件到这里，委派给远端 Hermes 处理
            </p>
            <p className="text-[11.5px] text-ink-dim mt-1.5">
              支持图片与文本类文件（代码 / 日志 / CSV 等）
            </p>
          </div>
        </div>
      )}

      {/* Top bar：端点状态一目了然 */}
      <div className="px-4 py-2 border-b border-line flex-shrink-0 flex items-center gap-2 min-h-[48px]">
        <span className="text-sm text-ink font-medium">远端 Hermes</span>
        <span className="text-[10px] text-sky bg-sakura/40 px-1.5 py-0.5 rounded">
          远端 Agent
        </span>
        <div className="flex-1" />
        {config && (
          <span
            className="flex items-center gap-1.5 text-xs text-ink-dim truncate max-w-[40%]"
            title={config.base_url || '未配置端点'}
          >
            <span
              className={
                'inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ' +
                (ready ? 'bg-done' : 'bg-awaiting')
              }
            />
            {config.configured
              ? config.base_url + (config.model ? ' · ' + config.model : '')
              : '未配置端点'}
          </span>
        )}
        <button
          onClick={() => navigate('/settings')}
          className="flex-shrink-0 text-xs text-sky hover:text-sky border border-line rounded-lg px-2.5 py-1.5 transition-colors"
          title="设置 → 远端处理 (Hermes)"
        >
          端点设置
        </button>
      </div>

      {/* 主区 */}
      {!hasMessages ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 overflow-y-auto py-6">
          <Mascot mood={ready ? 'happy' : 'idle'} size={80} />
          {ready ? (
            <>
              <div className="text-center">
                <h1 className="text-xl font-bold text-gradient mb-1">
                  把任务委派到远端处理
                </h1>
                <p className="text-sm text-ink-dim">
                  输入任务描述、拖入文件——请求将在你的 Hermes 服务器上执行
                </p>
              </div>
              <DeployGuide />
            </>
          ) : (
            <>
              <div className="text-center">
                <h1 className="text-xl font-bold text-gradient mb-1">
                  {config?.configured ? '远端 Hermes 已禁用' : '还没有配置远端 Hermes'}
                </h1>
                <p className="text-sm text-ink-dim mb-3">
                  {config?.configured
                    ? '请到设置中启用它，或检查端点配置。'
                    : '先在服务器上部署 Hermes，再到设置里填端点地址。'}
                </p>
                <button
                  onClick={() => navigate('/settings')}
                  className="px-4 py-2 rounded-lg bg-grad-primary shadow-glow-primary text-white text-sm transition-all hover:-translate-y-px"
                >
                  去设置 → 远端处理 (Hermes)
                </button>
              </div>
              <DeployGuide />
            </>
          )}
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex flex-col items-end">
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2 justify-end">
                      {m.attachments.map((a, i) =>
                        a.kind === 'image' && a.data_url ? (
                          <img
                            key={i}
                            src={a.data_url}
                            alt={a.name ?? '图片'}
                            className="max-h-40 rounded-lg border border-line object-cover"
                          />
                        ) : (
                          <span
                            key={i}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-2 border border-line text-xs text-ink-muted"
                          >
                            <span aria-hidden="true">📄</span>
                            {a.name ?? '文本文件'}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  {m.content && (
                    <div className="max-w-[85%] px-4 py-2.5 rounded-pop rounded-br-md bg-grad-primary shadow-glow-primary text-white text-[15px] leading-7 whitespace-pre-wrap break-words">
                      {m.content}
                    </div>
                  )}
                </div>
              ) : (
                <div key={m.id} className="w-full">
                  {m.status === 'error' ? (
                    <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-2.5 text-failed text-sm break-words">
                      {m.content || '远端处理出错'}
                    </div>
                  ) : m.content === '' && m.status === 'streaming' ? (
                    <div className="flex items-center gap-2 py-2 text-xs text-ink-dim">
                      <span className="w-2 h-2 rounded-full bg-ink-dim animate-pulse" />
                      远端 Hermes 处理中…
                    </div>
                  ) : (
                    <>
                      <Markdown text={m.content} />
                      {m.status === 'stopped' && (
                        <p className="text-xs text-ink-dim mt-1">（已停止）</p>
                      )}
                    </>
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      )}

      <Composer
        ref={composerRef}
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        disabled={!ready}
        onSend={(c, a) => void handleSend(c, a)}
        onStop={() => void handleStop()}
        showToast={showToast}
        placeholder={
          ready
            ? '描述要委派的任务，可拖入文件作为上下文，Enter 发送'
            : '未配置远端 Hermes——请先到「设置 → 远端处理 (Hermes)」填端点'
        }
        footerHint="任务在远端 Hermes 服务器上执行（带它的记忆 / skills），本机不参与计算。"
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-surface-2 border border-line text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
