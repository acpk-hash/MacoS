import { NavLink } from 'react-router-dom'
import { useSyncStore } from '../stores/syncStore'

function IconTask() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function IconChat() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function IconBell() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function IconGear() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

interface BadgeProps {
  count: number
}

function Badge({ count }: BadgeProps) {
  if (count === 0) return null
  return (
    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-coral text-white text-[10px] font-bold flex items-center justify-center">
      {count > 99 ? '99+' : count}
    </span>
  )
}

const linkBase =
  'flex flex-col items-center justify-center gap-0.5 flex-1 py-2 text-ink-faint transition-colors relative'
const linkActive = 'text-primary'

export default function BottomNav() {
  const unreadCount = useSyncStore((s) => s.unreadCount)
  const events = useSyncStore((s) => s.events)
  const newEvents = events.length

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-surface border-t border-line flex"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)', height: 'calc(56px + env(safe-area-inset-bottom, 0px))' }}
    >
      <NavLink
        to="/"
        end
        className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ''}`}
      >
        <IconTask />
        <span className="text-[10px] font-medium">任务</span>
      </NavLink>

      <NavLink
        to="/chat"
        className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ''}`}
      >
        <span className="relative">
          <IconChat />
          <Badge count={unreadCount} />
        </span>
        <span className="text-[10px] font-medium">对话</span>
      </NavLink>

      <NavLink
        to="/events"
        className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ''}`}
      >
        <span className="relative">
          <IconBell />
          <Badge count={newEvents} />
        </span>
        <span className="text-[10px] font-medium">事件</span>
      </NavLink>

      <NavLink
        to="/settings"
        className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ''}`}
      >
        <IconGear />
        <span className="text-[10px] font-medium">设置</span>
      </NavLink>
    </nav>
  )
}
