import { NavLink, Outlet } from 'react-router-dom'

const navItems = [
  { to: '/chat', label: '聊天', shortLabel: '聊' },
  { to: '/board', label: '看板', shortLabel: '板' },
  { to: '/settings', label: '设置', shortLabel: '设' },
]

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Left sidebar */}
      <aside className="w-16 flex flex-col items-center py-4 gap-6 bg-gray-900 border-r border-gray-800 flex-shrink-0">
        {/* Logo */}
        <div className="flex flex-col items-center">
          <span className="text-xs font-bold text-blue-400 leading-none">Agent</span>
          <span className="text-xs font-bold text-blue-300 leading-none">Board</span>
        </div>

        {/* Nav links */}
        <nav className="flex flex-col gap-1 w-full px-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              className={({ isActive }) =>
                [
                  'flex items-center justify-center h-10 rounded-lg text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
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
