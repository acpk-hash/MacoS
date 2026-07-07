import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initAgentEventListener } from './stores/agentStore'
import { initStudioEventListener } from './stores/studioStore'
import { initWorkbenchEventListener } from './stores/workbenchStore'

// Register the Tauri "agent-event" listener once before any component mounts.
// No-ops in browser / non-Tauri contexts.
initAgentEventListener().catch(console.warn)
// Register the "studio-event" listener (direct-API chat streaming) once.
initStudioEventListener().catch(console.warn)
// Register the "workbench-event" listener (F4 local workbench / pi engine) once.
initWorkbenchEventListener().catch(console.warn)

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
