interface SettingsSection {
  id: string
  title: string
  description: string
  badge?: string
}

const SECTIONS: SettingsSection[] = [
  {
    id: 'engine',
    title: '推理引擎',
    description: '配置 AI 推理后端，支持 OpenAI、Anthropic Claude、本地 Ollama 等多种提供商。',
    badge: '未配置',
  },
  {
    id: 'mcp',
    title: 'MCP 工具',
    description: '管理 Model Context Protocol 工具连接，扩展 Agent 的文件读写、网络访问等能力。',
    badge: '0 个工具',
  },
  {
    id: 'skills',
    title: 'Skills 技能库',
    description: '浏览并启用预置技能（深度研究、代码审查、调度等），快速赋能 Agent 工作流。',
    badge: '0 个启用',
  },
  {
    id: 'market',
    title: 'Agent 市场',
    description: '从社区市场安装预构建 Agent，一键部署到本地看板，开箱即用。',
    badge: '敬请期待',
  },
]

export default function Settings() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-base font-semibold text-gray-100">设置</h1>
        <p className="text-xs text-gray-500 mt-0.5">配置引擎、工具与技能</p>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {SECTIONS.map((section) => (
          <div
            key={section.id}
            className="bg-gray-800 border border-gray-700 rounded-xl p-4 hover:border-gray-600 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-gray-100">{section.title}</h2>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">{section.description}</p>
              </div>
              {section.badge && (
                <span className="flex-shrink-0 text-xs text-gray-500 bg-gray-700 px-2 py-1 rounded-lg">
                  {section.badge}
                </span>
              )}
            </div>
            <button className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium">
              配置 &rarr;
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
