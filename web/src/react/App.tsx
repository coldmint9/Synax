import { Navigate, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import WorkbenchLayout from './layouts/WorkbenchLayout'
import { WelcomeView } from './layouts/WelcomeView'
import AgentLoopTestPage from './pages/AgentLoopTestPage'
import GlobalSettingsPage from './features/settings/GlobalSettingsPage'
import ProjectSettingsPage from './features/settings/ProjectSettingsPage'
import { useElectronMenu } from '../lib/electron-menu'
import { useWikiStore } from './state/wikiStore'

export default function App() {
  useEffect(() => {
    if (navigator.userAgent.includes('Electron')) {
      document.documentElement.classList.add('electron')
    }
  }, [])

  useElectronMenu()

  const draftPreviewActive = useWikiStore(s => s.draftPreviewActive)

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
      {/* Draft preview mode glow overlay */}
      <div
        className={`pointer-events-none fixed inset-0 z-[9999] will-change-[opacity] transition-opacity duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
          draftPreviewActive ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ boxShadow: 'inset 0 0 40px 8px rgba(251,191,36,0.25), inset 0 0 12px 2px rgba(251,191,36,0.4)' }}
        aria-hidden="true"
      />
    </div>
  )
}
