import { useState, useRef, useEffect, FormEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useSyncStore } from '../stores/syncStore'

export default function ChatPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const chatSessions = useSyncStore((s) => s.chatSessions)
  const chatMessages = useSyncStore((s) => s.chatMessages)
  const sendChatMessage = useSyncStore((s) => s.sendChatMessage)

  const session = chatSessions.find((s) => s.id === id)
  const messages = chatMessages.filter((m) => m.session_id === id)

  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  function handleSend(e?: FormEvent) {
    e?.preventDefault()
    const text = input.trim()
    if (!text || !id) return
    sendChatMessage(id, text)
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    // auto-grow
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-line px-4 pt-12 pb-3 flex items-center gap-3">
        <button
          onClick={() => navigate('/chat')}
          className="w-9 h-9 -ml-1 flex items-center justify-center rounded-xl active:bg-surface-2 transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink truncate">
            {session?.title || '对话'}
          </p>
          {session?.model && (
            <p className="text-xs text-ink-faint">{session.model}</p>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-ink-faint">
            <p className="text-sm">暂无消息</p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`rounded-2xl px-4 py-3 max-w-[88%] ${
              msg.role === 'user'
                ? 'bg-primary text-white self-end'
                : msg.role === 'assistant'
                ? 'bg-editor border border-line text-ink self-start'
                : 'bg-surface-2 text-ink-muted self-center text-xs'
            }`}
          >
            <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">
              {msg.content}
            </pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div
        className="bg-bg border-t border-line px-3 py-3 flex items-end gap-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="发送消息…"
          className="flex-1 resize-none bg-editor border border-line rounded-2xl px-4 py-2.5 text-sm text-ink placeholder-ink-faint focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition leading-relaxed"
          style={{ minHeight: '44px', maxHeight: '120px' }}
        />
        <button
          onClick={() => handleSend()}
          disabled={!input.trim()}
          className="w-11 h-11 rounded-full bg-primary text-white flex items-center justify-center shrink-0 disabled:opacity-40 active:bg-primary-hover transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22l-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
