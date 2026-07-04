const PLACEHOLDER_MESSAGES = [
  { id: 1, role: 'assistant', text: '你好！我是 AgentBoard AI 助手，有什么可以帮助你的？' },
  { id: 2, role: 'user', text: '帮我分析一下当前任务进度。' },
  { id: 3, role: 'assistant', text: '好的，正在分析看板数据……（占位内容）' },
]

export default function Chat() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-base font-semibold text-gray-100">聊天工作区</h1>
        <p className="text-xs text-gray-500 mt-0.5">与 AI Agent 实时对话</p>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {PLACEHOLDER_MESSAGES.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={[
                'max-w-sm px-4 py-2.5 rounded-2xl text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-sm'
                  : 'bg-gray-800 text-gray-200 rounded-bl-sm',
              ].join(' ')}
            >
              {msg.text}
            </div>
          </div>
        ))}
      </div>

      {/* Input area */}
      <div className="px-5 py-3 border-t border-gray-800 flex-shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            rows={1}
            placeholder="输入消息，按 Enter 发送…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
          />
          <button className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors">
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
