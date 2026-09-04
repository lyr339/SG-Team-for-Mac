import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyAppearancePreferences, readAppearancePreferences } from './appearance-preferences'
import './claude-theme.css'
import './styles.css'
import './team-v2.css'
import './team-setup.css'
import './lobby/lobby.css'
import './controls.css'
import './workspace-inspector.css'

applyAppearancePreferences(readAppearancePreferences())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
