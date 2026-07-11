import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Chat from './pages/Chat'
import Board from './pages/Board'
import Settings from './pages/Settings'
import StudioChat from './pages/StudioChat'
import StudioGen from './pages/StudioGen'
import Canvas from './pages/Canvas'
import Workbench from './pages/Workbench'
import Sediment from './pages/Sediment'
import Artifacts from './pages/Artifacts'
import Research from './pages/Research'
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
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<Chat />} />
          <Route path="board" element={<Board />} />
          <Route path="studio/chat" element={<StudioChat />} />
          <Route path="studio/gen" element={<StudioGen />} />
          <Route path="artifacts" element={<Artifacts />} />
          <Route path="workbench" element={<Workbench />} />
          <Route path="sediment" element={<Sediment />} />
          <Route path="research" element={<Research />} />
          <Route path="canvas" element={<Canvas />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
