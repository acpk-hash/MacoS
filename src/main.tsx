import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 圆润字体（M PLUS Rounded 1c）— 打包在本地，离线可用。
import '@fontsource/m-plus-rounded-1c/400.css'
import '@fontsource/m-plus-rounded-1c/500.css'
import '@fontsource/m-plus-rounded-1c/700.css'
import '@fontsource/m-plus-rounded-1c/800.css'
import './index.css'
import App from './App'
import { initAgentEventListener } from './stores/agentStore'
import { initStudioEventListener } from './stores/studioStore'
import { initArtifactEventListener } from './stores/artifactStore'
import { initWorkbenchEventListener } from './stores/workbenchStore'

// Register the Tauri "agent-event" listener once before any component mounts.
// No-ops in browser / non-Tauri contexts.
initAgentEventListener().catch(console.warn)
// Register the "studio-event" listener (direct-API chat streaming) once.
initStudioEventListener().catch(console.warn)
// Register the artifact studio-event listener (H3 HTML doc/PPT generation) once.
initArtifactEventListener().catch(console.warn)
// Register the "workbench-event" listener (F4 local workbench / pi engine) once.
initWorkbenchEventListener().catch(console.warn)

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
