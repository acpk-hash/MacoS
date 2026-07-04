interface KanbanCard {
  id: number
  title: string
}

interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
}

const COLUMNS: KanbanColumn[] = [
  {
    id: 'todo',
    title: '待办',
    cards: [
      { id: 1, title: '优化提示词模板' },
      { id: 2, title: '接入 MCP 工具市场' },
      { id: 3, title: '添加快捷键支持' },
    ],
  },
  {
    id: 'in-progress',
    title: '进行中',
    cards: [
      { id: 4, title: '实现看板拖拽排序' },
      { id: 5, title: '集成 Tauri 文件系统 API' },
    ],
  },
  {
    id: 'review',
    title: '待确认',
    cards: [
      { id: 6, title: '深色主题设计评审' },
    ],
  },
  {
    id: 'done',
    title: '已完成',
    cards: [
      { id: 7, title: '项目初始化' },
      { id: 8, title: '路由与页面骨架' },
    ],
  },
]

export default function Board() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-base font-semibold text-gray-100">任务看板</h1>
        <p className="text-xs text-gray-500 mt-0.5">跟踪 Agent 任务执行状态</p>
      </div>

      {/* Kanban columns */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="flex gap-4 h-full">
          {COLUMNS.map((col) => (
            <div key={col.id} className="w-60 flex-shrink-0 flex flex-col gap-3">
              {/* Column header */}
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-gray-300">{col.title}</h2>
                <span className="bg-gray-700 text-gray-400 text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {col.cards.length}
                </span>
              </div>

              {/* Cards */}
              <div className="flex flex-col gap-2 overflow-y-auto">
                {col.cards.map((card) => (
                  <div
                    key={card.id}
                    className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-200 cursor-pointer hover:border-gray-500 hover:bg-gray-750 transition-colors select-none"
                  >
                    {card.title}
                  </div>
                ))}

                {/* Add card placeholder */}
                <button className="border border-dashed border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-600 hover:text-gray-400 hover:border-gray-600 transition-colors text-left">
                  + 添加任务
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
