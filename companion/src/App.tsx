import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import { useSyncStore } from './stores/syncStore'
import BottomNav from './components/BottomNav'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import ChatListPage from './pages/ChatListPage'
import ChatPage from './pages/ChatPage'
import EventsPage from './pages/EventsPage'
import SettingsPage from './pages/SettingsPage'

function MainLayout() {
  return (
    <div className="flex flex-col h-screen bg-bg overflow-hidden">
      <main className="flex-1 overflow-hidden relative">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  )
}

function AuthGuard() {
  const { loggedIn, isHydrated } = useAuthStore()

  if (!isHydrated) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!loggedIn) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

function AppRoutes() {
  const { loggedIn, isHydrated, hydrate } = useAuthStore()
  const init = useSyncStore((s) => s.init)
  const destroy = useSyncStore((s) => s.destroy)

  // Hydrate auth on mount
  useEffect(() => {
    hydrate()
  }, [hydrate])

  // Connect WS when logged in
  useEffect(() => {
    if (isHydrated && loggedIn) {
      init()
      return () => {
        destroy()
      }
    }
    return undefined
  }, [isHydrated, loggedIn, init, destroy])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<AuthGuard />}>
        <Route element={<MainLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/chat" element={<ChatListPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      {/* Redirect root to login if not caught above */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
