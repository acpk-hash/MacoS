import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initAgentEventListener } from './stores/agentStore'

// Register the Tauri "agent-event" listener once before any component mounts.
// No-ops in browser / non-Tauri contexts.
initAgentEventListener().catch(console.warn)

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
