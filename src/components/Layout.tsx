import { NavLink, Outlet } from 'react-router-dom'
import Logo from './Logo'

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

// "沉淀" group (Hermes-style local asset library: 运行历史 / 技能库).
const sedimentItems = [
  { to: '/sediment', label: '沉淀', title: '沉淀 · 运行历史 / 技能库' },
]

// Bottom utility links.
const navItems = [{ to: '/settings', label: '设置' }]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'group flex flex-col items-center justify-center h-10 rounded-btn text-xs font-medium transition-all duration-150',
    isActive
      ? 'text-primary bg-primary-tint font-semibold'
      : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
  ].join(' ')

type NavItem = { to: string; label: string; hint?: string; title?: string }

function NavEntry({ item }: { item: NavItem }) {
  return (
    <NavLink to={item.to} title={item.title ?? item.label} className={linkClass}>
      <span className="leading-none">{item.label}</span>
      {item.hint && (
        <span className="text-[8px] text-ink-dim leading-none mt-0.5">
          {item.hint}
        </span>
      )}
    </NavLink>
  )
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[9px] text-ink-dim/80 text-center mb-1 tracking-wider select-none">
      {children}
    </span>
  )
}

export default function Layout() {
  return (
    <div className="flex h-screen text-ink">
      {/* Left sidebar */}
      <aside className="w-16 flex flex-col items-center py-4 gap-4 bg-surface border-r border-line flex-shrink-0 z-10">
        {/* Logo — 欧拉 φ 标志 + 品牌字 */}
        <div className="flex flex-col items-center gap-1">
          <Logo size={34} />
          <div className="flex flex-col items-center leading-none">
            <span className="text-[11px] font-extrabold text-primary leading-none">Agent</span>
            <span className="text-[11px] font-extrabold text-primary leading-none">Board</span>
          </div>
        </div>

        {/* 工作台 group */}
        <nav className="flex flex-col gap-1 w-full px-2">
          <GroupTitle>工作台</GroupTitle>
          {studioItems.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>

        {/* Agent group */}
        <nav className="flex flex-col gap-1 w-full px-2">
          <GroupTitle>Agent</GroupTitle>
          {agentItems.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>

        {/* 沉淀 group */}
        <nav className="flex flex-col gap-1 w-full px-2">
          <GroupTitle>沉淀</GroupTitle>
          {sedimentItems.map((item) => (
            <NavEntry key={item.to} item={item} />
          ))}
        </nav>

        {/* Divider */}
        <div className="w-8 divider-soft" />

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
