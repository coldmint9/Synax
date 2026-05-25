import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, useNavigate } from 'react-router-dom'
import { RouterProvider } from '@heroui/react'
import App from './react/App'
import './index.css'
import 'streamdown/styles.css'
import { hydrateShellPreferences, useShellStore } from './react/state/shellStore'
import { initApiOrigin } from './lib/api/origin'

hydrateShellPreferences()
const theme = useShellStore.getState().preferences.theme
document.documentElement.classList.toggle('dark', theme === 'dark')

function HeroUIRouter({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <RouterProvider navigate={navigate}>
      {children}
    </RouterProvider>
  )
}

async function bootstrap() {
  await initApiOrigin()
  ReactDOM.createRoot(document.getElementById('app')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <HeroUIRouter>
          <App />
        </HeroUIRouter>
      </BrowserRouter>
    </React.StrictMode>,
  )
}

bootstrap()
