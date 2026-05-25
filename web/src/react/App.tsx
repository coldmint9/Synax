import { Navigate, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import WorkbenchLayout from './layouts/WorkbenchLayout'
import { WelcomeView } from './layouts/WelcomeView'
import AgentLoopTestPage from './pages/AgentLoopTestPage'
import GlobalSettingsPage from './features/settings/GlobalSettingsPage'
import ProjectSettingsPage from './features/settings/ProjectSettingsPage'
import { useElectronMenu } from '../lib/electron-menu'

export default function App() {
  useEffect(() => {
    if (navigator.userAgent.includes('Electron')) {
      document.documentElement.classList.add('electron')
    }
  }, [])

  useElectronMenu()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1">
        <Routes>
          <Route element={<WorkbenchLayout />}>
            <Route path="/" element={<WelcomeView />} />
            <Route path="/settings" element={<GlobalSettingsPage />} />
            <Route path="/projects/:projectId" element={<Navigate to="wiki" replace />} />
            {/* wiki/sessions 由 WorkbenchLayout keep-alive 块渲染，路由仅用于 URL 匹配 */}
            <Route path="/projects/:projectId/wiki" element={null} />
            <Route path="/projects/:projectId/sessions" element={null} />
            <Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />
          </Route>
          <Route path="/agent-loop-test" element={<AgentLoopTestPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  )
}
