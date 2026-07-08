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

export default function App() {
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
