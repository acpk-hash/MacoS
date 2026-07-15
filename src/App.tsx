import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import PiShell from './pages/PiShell'
import Office from './pages/Office'
import ImageStudio from './pages/ImageStudio'
import VideoStudio from './pages/VideoStudio'
import Science from './pages/Science'
import Auto from './pages/Auto'
import Skills from './pages/Skills'
import McpHub from './pages/McpHub'
import HooksHub from './pages/HooksHub'
import AgentHub from './pages/AgentHub'
import KnowledgeBase from './pages/KnowledgeBase'
import Canvas from './pages/Canvas'
import Commerce from './pages/Commerce'
import Usage from './pages/Usage'
import Trends from './pages/Trends'
import Settings from './pages/Settings'
import DeepResearch from './pages/DeepResearch'
import ScheduledTasks from './pages/ScheduledTasks'
import ModelCompare from './pages/ModelCompare'
import VectorSearch from './pages/VectorSearch'
import Webhooks from './pages/Webhooks'
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
          <Route path="office" element={<Office />} />
          <Route path="image" element={<ImageStudio />} />
          <Route path="video" element={<VideoStudio />} />
          <Route path="science" element={<Science />} />
          <Route path="auto" element={<Auto />} />
          <Route path="skills" element={<Skills />} />
          <Route path="mcp" element={<McpHub />} />
          <Route path="hooks" element={<HooksHub />} />
          <Route path="agent" element={<AgentHub />} />
          <Route path="kb" element={<KnowledgeBase />} />
          <Route path="canvas" element={<Canvas />} />
          <Route path="commerce" element={<Commerce />} />
          <Route path="usage" element={<Usage />} />
          <Route path="trends" element={<Trends />} />
          <Route path="research" element={<DeepResearch />} />
          <Route path="schedule" element={<ScheduledTasks />} />
          <Route path="compare" element={<ModelCompare />} />
          <Route path="vector" element={<VectorSearch />} />
          <Route path="webhooks" element={<Webhooks />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}