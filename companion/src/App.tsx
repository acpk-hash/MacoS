import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import MobileLayout from './components/MobileLayout'
import { useAuthStore } from './stores/authStore'
import { useSyncStore } from './stores/syncStore'
import { seedBuiltinProviders } from './lib/api'

import Login from './pages/Login'
import Chat from './pages/Chat'
import Tools from './pages/Tools'
import Explore from './pages/Explore'
import Data from './pages/Data'
import Settings from './pages/Settings'
import Office from './pages/Office'
import ImageStudio from './pages/ImageStudio'
import VideoStudio from './pages/VideoStudio'
import Science from './pages/Science'
import DeepResearch from './pages/DeepResearch'
import Auto from './pages/Auto'
import Skills from './pages/Skills'
import McpHub from './pages/McpHub'
import HooksHub from './pages/HooksHub'
import AgentHub from './pages/AgentHub'
import KnowledgeBase from './pages/KnowledgeBase'
import Canvas from './pages/Canvas'
import Commerce from './pages/Commerce'
import Trends from './pages/Trends'
import Usage from './pages/Usage'
import ScheduledTasks from './pages/ScheduledTasks'
import ModelCompare from './pages/ModelCompare'
import VectorSearch from './pages/VectorSearch'
import Webhooks from './pages/Webhooks'
import Remote from './pages/Remote'

export default function App() {
  const { checked, loggedIn, localMode } = useAuthStore()
  const initSync = useSyncStore(s => s.init)

  useEffect(() => {
    seedBuiltinProviders()
    useAuthStore.getState().hydrate()
  }, [])

  useEffect(() => {
    if (loggedIn) initSync()
    return () => useSyncStore.getState().destroy()
  }, [loggedIn, initSync])

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3 animate-in">
          <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-ink-dim">加载中…</p>
        </div>
      </div>
    )
  }

  if (!loggedIn && !localMode) {
    return <Login />
  }

  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route path="/" element={<MobileLayout />}>
          <Route index element={<Chat />} />
          <Route path="tools" element={<Tools />} />
          <Route path="explore" element={<Explore />} />
          <Route path="data" element={<Data />} />
          <Route path="settings" element={<Settings />} />
          <Route path="office" element={<Office />} />
          <Route path="image" element={<ImageStudio />} />
          <Route path="video" element={<VideoStudio />} />
          <Route path="science" element={<Science />} />
          <Route path="research" element={<DeepResearch />} />
          <Route path="auto" element={<Auto />} />
          <Route path="skills" element={<Skills />} />
          <Route path="mcp" element={<McpHub />} />
          <Route path="hooks" element={<HooksHub />} />
          <Route path="agent" element={<AgentHub />} />
          <Route path="kb" element={<KnowledgeBase />} />
          <Route path="canvas" element={<Canvas />} />
          <Route path="commerce" element={<Commerce />} />
          <Route path="trends" element={<Trends />} />
          <Route path="usage" element={<Usage />} />
          <Route path="schedule" element={<ScheduledTasks />} />
          <Route path="compare" element={<ModelCompare />} />
          <Route path="vector" element={<VectorSearch />} />
          <Route path="webhooks" element={<Webhooks />} />
          <Route path="remote" element={<Remote />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
