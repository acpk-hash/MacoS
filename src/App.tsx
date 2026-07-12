import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import PiShell from './pages/PiShell'
import Settings from './pages/Settings'
import Login from './pages/Login'
import { useAuthStore } from './stores/authStore'

export default function App() {
  const { checked, loggedIn, localMode } = useAuthStore()

  // 启动探测未完成前不闪门户（sync_status 是本地查询，通常瞬时完成）。
  if (!checked) {
    return <div className="min-h-screen bg-bg" />
  }

  // 账号门户：未登录且未选择本地模式 → 登录/注册（含「本地模式」入口）。
  if (!loggedIn && !localMode) {
    return <Login />
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<PiShell />} />
          {/* 旧 /pi 路径保留为别名，统一跳回根路由。 */}
          <Route path="pi" element={<Navigate to="/" replace />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
