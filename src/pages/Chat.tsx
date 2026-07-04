import React, { useEffect, useRef, useState } from 'react'
import { useAgentStore, type TimelineEntry } from '../stores/agentStore'

// ── Tauri environment guard ───────────────────────────────────────────────────

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

// ── Simple markdown renderer (no heavy libs) ──────────────────────────────────

function renderText(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {line}
    </React.Fragment>
  ))
}

function renderMarkdown(text: string): React.ReactNode {
  // Split on fenced code blocks; preserve delimiters for identification.
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
      return (
        <pre
          key={i}
          className="bg-gray-950 rounded p-2 mt-1 mb-1 text-xs font-mono overflow-x-auto whitespace-pre-wrap"
        >
          {code}
        </pre>
      )
    }
    return <span key={i}>{renderText(part)}</span>
  })
}

// ── Timeline entry components ─────────────────────────────────────────────────

function EntryView({
  entry,
  onToggleExpand,
}: {
  entry: TimelineEntry
  onToggleExpand: () => void
}) {
  switch (entry.kind) {
    case 'user_message':
      return (
        <div className="flex justify-end">
          <div className="max-w-lg px-4 py-2.5 rounded-2xl rounded-br-sm bg-blue-600 text-white text-sm leading-relaxed break-words">
            {renderText(entry.text)}
          </div>
        </div>
      )

    case 'assistant_message':
      return (
        <div className="flex justify-start">
          <div className="max-w-lg px-4 py-2.5 rounded-2xl rounded-bl-sm bg-gray-800 text-gray-200 text-sm leading-relaxed break-words">
            {renderMarkdown(entry.text)}
          </div>
        </div>
      )

    case 'file_edit': {
      const filename = entry.path.split(/[\\/]/).pop() ?? entry.path
      return (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-0.5 pl-1">
          <span aria-hidden="true">✏️</span>
          <span>
            修改{' '}
            <code
              className="text-blue-400 font-mono"
              title={entry.path}
            >
              {filename}
            </code>
          </span>
          <span className="text-gray-600 capitalize">{entry.editKind}</span>
        </div>
      )
    }

    case 'command_run': {
      const isSuccess = entry.exitCode === 0
      const shortCmd =
        entry.cmd.length > 120 ? entry.cmd.slice(0, 120) + '…' : entry.cmd
      return (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-2 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 flex-shrink-0" aria-hidden="true">▶</span>
            <span
              className="text-gray-300 flex-1 truncate"
              title={entry.cmd}
            >
              {shortCmd}
            </span>
            <span
              className={[
                'flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-sans font-medium',
                isSuccess
                  ? 'bg-green-900/60 text-green-400'
                  : 'bg-red-900/60 text-red-400',
              ].join(' ')}
            >
              {entry.exitCode}
            </span>
            {entry.outputTail && (
              <button
                onClick={onToggleExpand}
                className="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
                title={entry.expanded ? '收起输出' : '展开输出'}
              >
                {entry.expanded ? '▲' : '▼'}
              </button>
            )}
          </div>
          {entry.expanded && entry.outputTail && (
            <pre className="mt-2 text-gray-400 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto border-t border-gray-800 pt-2">
              {entry.outputTail}
            </pre>
          )}
        </div>
      )
    }

    case 'usage':
      return (
        <div className="text-xs text-gray-600 text-center py-0.5">
          tokens — in {entry.inputTokens.toLocaleString()} (cached{' '}
          {entry.cachedInputTokens.toLocaleString()}) / out{' '}
          {entry.outputTokens.toLocaleString()} / reasoning{' '}
          {entry.reasoningOutputTokens.toLocaleString()}
        </div>
      )

    case 'error':
      return (
        <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-2 text-red-400 text-sm break-words">
          {entry.message}
        </div>
      )

    default:
      return null
  }
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/70 text-blue-300 border border-blue-800">
        运行中
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/70 text-green-300 border border-green-800">
        已完成
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/70 text-red-300 border border-red-800">
        出错
      </span>
    )
  }
  return null
}

// ── Main Chat component ───────────────────────────────────────────────────────

export default function Chat() {
  const {
    sessions,
    activeSessionId,
    createSession,
    setActiveSession,
    addUserMessage,
    markSessionRunning,
    toggleCommandExpanded,
  } = useAgentStore()

  const [workdir, setWorkdir] = useState('')
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)

  const timelineEndRef = useRef<HTMLDivElement>(null)

  const activeSession = activeSessionId ? sessions[activeSessionId] : null
  const isRunning = activeSession?.status === 'running' || sending
  const canSendFollowup =
    activeSessionId != null &&
    (activeSession?.status === 'done' || activeSession?.status === 'error')

  // Auto-scroll to bottom when new entries arrive.
  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeSession?.entries.length])

  // ── Non-Tauri fallback UI ──────────────────────────────────────────────────
  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-gray-400 text-sm">请在桌面应用中使用</p>
        <p className="text-gray-600 text-xs">
          此功能需要 Tauri 桌面运行时，无法在普通浏览器中运行。
        </p>
      </div>
    )
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleNewSession = () => {
    setActiveSession(null)
    setInputText('')
  }

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || isRunning) return

    setInputText('')
    setSending(true)

    try {
      if (!activeSessionId || !sessions[activeSessionId]) {
        // ── Start a new session ──
        const sessionId = await tauriInvoke<string>('agent_start', {
          prompt: text,
          workdir: workdir.trim() || '.',
        })
        createSession(sessionId)
        addUserMessage(sessionId, text)
      } else if (canSendFollowup) {
        // ── Send a follow-up turn ──
        addUserMessage(activeSessionId, text)
        markSessionRunning(activeSessionId)
        await tauriInvoke<void>('agent_followup', {
          sessionId: activeSessionId,
          text,
        })
      }
    } catch (err) {
      console.error('[Chat] send failed:', err)
    } finally {
      setSending(false)
    }
  }

  const handleCancel = async () => {
    if (!activeSessionId || !isRunning) return
    try {
      await tauriInvoke<void>('agent_cancel', { sessionId: activeSessionId })
    } catch (err) {
      console.error('[Chat] cancel failed:', err)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const entries = activeSession?.entries ?? []

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-b border-gray-800 flex-shrink-0 flex items-center gap-2 min-h-[44px]">
        <input
          type="text"
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          placeholder="选择 agent 工作目录"
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
        />

        <button
          onClick={handleNewSession}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors whitespace-nowrap"
        >
          新会话
        </button>

        {activeSession && <StatusBadge status={activeSession.status} />}

        {isRunning && (
          <button
            onClick={handleCancel}
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800 text-red-300 border border-red-800 transition-colors whitespace-nowrap"
          >
            取消
          </button>
        )}
      </div>

      {/* ── Timeline ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-600 text-sm select-none">
              输入提示词开始新会话
            </p>
          </div>
        ) : (
          entries.map((entry, idx) => (
            <EntryView
              key={idx}
              entry={entry}
              onToggleExpand={() =>
                activeSessionId &&
                toggleCommandExpanded(activeSessionId, idx)
              }
            />
          ))
        )}
        <div ref={timelineEndRef} />
      </div>

      {/* ── Input area ────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-t border-gray-800 flex-shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            rows={2}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isRunning
                ? 'Agent 运行中，请稍候…'
                : '输入提示词，Enter 发送，Shift+Enter 换行…'
            }
            disabled={isRunning}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={isRunning || !inputText.trim()}
            className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
