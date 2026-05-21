import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './react/App'
import './index.css'
import '@xyflow/react/dist/style.css'
import 'streamdown/styles.css'
import { hydrateShellPreferences, useShellStore } from './react/state/shellStore'

hydrateShellPreferences()
const theme = useShellStore.getState().preferences.theme
document.documentElement.classList.toggle('dark', theme === 'dark')

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
