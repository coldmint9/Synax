import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useShellStore } from '../react/state/shellStore';

const api = (window as any).electronAPI;

export function useElectronMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const projects = useShellStore((s) => s.projects);

  useEffect(() => {
    if (!api) return;

    api.onMenuNavigate((path: string) => {
      navigate(path);
    });

    api.onMenuAction((action: string) => {
      const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
      const projectId = projectMatch?.[1];

      switch (action) {
        case 'view:coordinates':
          if (projectId) navigate(`/projects/${projectId}/coordinates`);
          break;
        case 'view:wiki':
          if (projectId) navigate(`/projects/${projectId}/wiki`);
          break;
        case 'view:sessions':
          if (projectId) navigate(`/projects/${projectId}/sessions`);
          break;
        case 'toggle:sidebar':
          document.dispatchEvent(new CustomEvent('menu:toggle-sidebar'));
          break;
      }
    });
  }, [navigate, location.pathname]);

  useEffect(() => {
    if (!api) return;
    const simplified = projects.map((p) => ({ id: p.id, name: p.name }));
    api.updateProjects(simplified);
  }, [projects]);
}
