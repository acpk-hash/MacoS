import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import Logo from './Logo'
import { useAuthStore } from '../stores/authStore'
import { useProviderStore } from '../stores/providerStore'

// 极简导航：编码（pi 三栏壳，产品主界面）+ 设置。
const navItems = [
  { to: '/', label: '编码', title: '编码 · pi 三栏工作区', end: true },
  { to: '/settings', label: '设置', title: '设置 · 服务商 / Key / 账号' },
]

// VSCode 活动栏式导航项：选中态 = 左侧 2px 强调条 + accent-soft 底 + 亮字。
const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'group relative flex flex-col items-center justify-center h-9 rounded-btn text-xs transition-colors duration-150',
    isActive
      ? 'text-ink bg-primary-tint font-semibold'
      : 'text-ink-dim hover:bg-surface-2 hover:text-ink-muted',
  ].join(' ')

type NavItem = { to: string; label: string; title?: string; end?: boolean }

function NavEntry({ item }: { item: NavItem }) {
  return (
    <NavLink to={item.to} end={item.end} title={item.title ?? item.label} className={linkClass}>
      {({ isActive }) => (
        <>
          {/* VSCode 式左侧强调条 */}
          <span
            aria-hidden="true"
            className={
              'absolute left-[-8px] top-1.5 bottom-1.5 w-[2px] rounded-full transition-colors ' +
              (isActive ? 'bg-primary' : 'bg-transparent')
            }
          />
          <span className="leading-none">{item.label}</span>
        </>
      )}
    </NavLink>
  )
}

/** 活动栏底部账号块：已登录显示用户名+退出登录；本地模式显示登录入口。 */
function AccountBlock() {
  const { loggedIn, username, logout, openPortal } = useAuthStore()
  const navigate = useNavigate()

  if (loggedIn) {
    const name = username ?? '账号'
    return (
      <div className="w-full px-2 flex flex-col items-center gap-1">
        <button
          onClick={() => navigate('/settings')}
          title={'账号：' + name + ' · 点击查看账号与同步设置'}
          className="w-8 h-8 rounded-full bg-primary text-white text-sm font-bold
                     flex items-center justify-center hover:bg-primary-hover transition-colors"
        >
          {name.charAt(0).toUpperCase()}
        </button>
        <span className="w-full text-[9px] text-ink-muted text-center truncate leading-tight" title={name}>
          {name}
        </span>
        <button
          onClick={() => void logout()}
          title="退出登录（回本地模式，本地数据保留）"
          className="text-[9px] text-ink-dim hover:text-failed transition-colors leading-none"
        >
          退出登录
        </button>
      </div>
    )
  }

  return (
    <div className="w-full px-2 flex flex-col items-center gap-1">
      <button
        onClick={openPortal}
        title="本地模式 · 点击登录以在手机和电脑间同步数据"
        className="w-8 h-8 rounded-full bg-surface-2 border border-line text-ink-dim text-xs
                   flex items-center justify-center hover:border-primary hover:text-primary transition-colors"
      >
        登
      </button>
      <span className="text-[9px] text-ink-dim text-center leading-tight">本地模式</span>
      <button
        onClick={openPortal}
        className="text-[9px] text-primary hover:text-primary-hover transition-colors leading-none"
      >
        登录
      </button>
    </div>
  )
}

/** 底部状态栏（VSCode 式细条）：账号 / 引擎状态 / 品牌，小字分段。 */
function StatusBar() {
  const { loggedIn, username, openPortal } = useAuthStore()
  const providers = useProviderStore((s) => s.providers)
  const navigate = useNavigate()

  const providerCount = providers.length

  return (
    <footer className="statusbar">
      {/* 左：账号 */}
      <button
        className="statusbar-item clickable"
        title={loggedIn ? '账号与同步设置' : '本地模式 · 点击登录同步'}
        onClick={() => (loggedIn ? navigate('/settings') : openPortal())}
      >
        <span
          className={
            'inline-block w-1.5 h-1.5 rounded-full ' +
            (loggedIn ? 'bg-done' : 'bg-ink-faint')
          }
        />
        {loggedIn ? (username ?? '账号') : '本地模式'}
      </button>
      {/* 引擎（服务商）状态 */}
      <button
        className="statusbar-item clickable"
        title="模型服务商 · 点击去设置"
        onClick={() => navigate('/settings')}
      >
        <span
          className={
            'inline-block w-1.5 h-1.5 rounded-full ' +
            (providerCount > 0 ? 'bg-running' : 'bg-awaiting')
          }
        />
        引擎 {providerCount}
      </button>
      <span className="flex-1" />
      {/* 右：品牌段 */}
      <span className="statusbar-item font-mono">UTF-8</span>
      <span className="statusbar-item">
        <Logo size={12} glyphOnly />
        AgentBoard
      </span>
    </footer>
  )
}

export default function Layout() {
  return (
    <div className="flex flex-col h-screen text-ink bg-bg">
      <div className="flex flex-1 min-h-0">
        {/* 活动栏（VSCode activity bar 观感：最深底 + 右细边） */}
        <aside className="w-16 flex flex-col items-center py-3 gap-3 bg-bg border-r border-line flex-shrink-0 z-10 overflow-y-auto overflow-x-hidden">
          {/* Logo — 欧拉 φ 标志 + 品牌字 */}
          <div className="flex flex-col items-center gap-1">
            <Logo size={30} />
            <div className="flex flex-col items-center leading-none">
              <span className="text-[10px] font-bold text-ink-muted leading-none">Agent</span>
              <span className="text-[10px] font-bold text-ink-muted leading-none">Board</span>
            </div>
          </div>

          {/* 主导航：编码 / 设置 */}
          <nav className="flex flex-col gap-0.5 w-full px-2">
            {navItems.map((item) => (
              <NavEntry key={item.to} item={item} />
            ))}
          </nav>

          {/* 账号（底部固定） */}
          <div className="mt-auto w-full">
            <AccountBlock />
          </div>
        </aside>

        {/* Main content area（编辑器底色，略亮于活动栏） */}
        <main className="flex-1 overflow-hidden bg-editor">
          <Outlet />
        </main>
      </div>

      {/* 底部状态栏 */}
      <StatusBar />
    </div>
  )
}
