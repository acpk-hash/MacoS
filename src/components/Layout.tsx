import { NavLink, Outlet } from 'react-router-dom'

// "工作台" group (direct-API studio) — unchanged.
const studioItems = [
  { to: '/studio/chat', label: '对话' },
  { to: '/studio/gen', label: '生成' },
]

// "Agent" group. 工作台 (local pi workbench) is the prominent third feature,
// followed by 任务看板 and Agent 会话. 画布 is demoted to the tail as a
// read-only "执行流" view (F4c).
const agentItems = [
  { to: '/workbench', label: '工作台', title: '工作台 · 本地工作平台' },
  { to: '/board', label: '看板', title: '任务看板' },
  { to: '/chat', label: '会话', title: 'Agent 会话' },
  { to: '/canvas', label: '画布', hint: '执行流', title: '画布 · 执行流(只读查看视图)' },
]

// Bottom utility links.
const navItems = [{ to: '/settings', label: '设置' }]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex flex-col items-center justify-center h-10 rounded-lg text-xs font-medium transition-colors',
    isActive
      ? 'bg-blue-600 text-white'
      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100',
  ].join(' ')

type NavItem = { to: string; label: string; hint?: string; title?: string }

function NavEntry({ item }: { item: NavItem }) {
  return (
    <NavLink to={item.to} title={item.title ?? item.label} className={linkClass}>
      <span className="leading-none">{item.label}</span>
      {item.hint && (
        <span className="text-[8px] text-gray-500 leading-none mt-0.5">{item.hint}</span>
      )}
    </NavLink>
  )
}

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Left sidebar */}
      <aside className="w-16 flex flex-col items-center py-4 gap-4 bg-gray-900 border-r border-gray-800 flex-shrink-0">
        {/* Logo */}
        <div className="flex flex-col items-center">
          <span className="text-xs font-bold text-blue-400 leading-none">Agent</span>
          <span className="text-xs font-bold text-blue-300 leading-none">Board</span>
        </div>

        {/* 工作台 group */}
        <nav className="flex flex-col gap-1 w-full px-2">
          <span className="text-[9px] text-gray-600 text-center mb-0.5 select-none">
            工作台
          </span>
          {studioItems.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>

        {/* Agent group */}
        <nav className="flex flex-col gap-1 w-full px-2">
          <span className="text-[9px] text-gray-600 text-center mb-0.5 select-none">
            Agent
          </span>
          {agentItems.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>

        {/* Divider */}
        <div className="w-8 border-t border-gray-800" />

        {/* Utility links */}
        <nav className="flex flex-col gap-1 w-full px-2">
          {navItems.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>
      </aside>

      {/* Main content area */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
