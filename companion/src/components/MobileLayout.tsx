import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import Logo from './Logo'
import { useAuthStore } from '../stores/authStore'
import { useSyncStore } from '../stores/syncStore'

const tabs = [
  {
    to: '/', label: '对话', end: true,
    icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  },
  {
    to: '/tools', label: '工具',
    icon: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></>,
  },
  {
    to: '/explore', label: '探索',
    icon: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  },
  {
    to: '/data', label: '数据',
    icon: <><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></>,
  },
  {
    to: '/settings', label: '设置',
    icon: <><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /></>,
  },
]

function TabIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className="w-[22px] h-[22px]">
      {children}
    </svg>
  )
}

function SyncBadge() {
  const ws = useSyncStore(s => s.wsState)
  const dotCls = ws === 'connected' ? 'dot-ok' : ws === 'connecting' || ws === 'reconnecting' ? 'dot-warn pulse' : 'dot-off'
  return <span className={`dot ${dotCls} ml-1`} title={ws} />
}

function Header() {
  const { loggedIn, username } = useAuthStore()
  const navigate = useNavigate()
  return (
    <header className="flex items-center px-4 py-2.5 bg-editor border-b border-line-soft flex-shrink-0"
      style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}>
      <Logo size={26} />
      <span className="ml-2 text-sm font-bold text-ink">Iris</span>
      <span className="ml-1 text-[10px] text-ink-dim font-medium">v0.14.0</span>
      <SyncBadge />
      <span className="flex-1" />
      {loggedIn ? (
        <button onClick={() => navigate('/settings')}
          className="w-7 h-7 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center">
          {(username || '?')[0].toUpperCase()}
        </button>
      ) : (
        <button onClick={() => navigate('/login')}
          className="text-xs text-primary font-medium">登录</button>
      )}
    </header>
  )
}

export default function MobileLayout() {
  return (
    <div className="flex flex-col h-screen bg-bg">
      <Header />
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
      <nav className="tab-bar">
        {tabs.map(t => (
          <NavLink key={t.to} to={t.to} end={t.end}
            className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>
            <TabIcon>{t.icon}</TabIcon>
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
