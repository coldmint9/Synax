import { useEffect, useState } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";

type WindowState = { maximized: boolean };

type DesktopWindowApi = {
  platform?: string;
  minimizeWindow?: () => Promise<boolean>;
  toggleMaximizeWindow?: () => Promise<boolean>;
  closeWindow?: () => Promise<boolean>;
  getWindowState?: () => Promise<WindowState>;
  onWindowStateChanged?: (callback: (state: WindowState) => void) => () => void;
};

function desktopWindowApi(): DesktopWindowApi | undefined {
  return (window as Window & { electronAPI?: DesktopWindowApi }).electronAPI;
}

export function WindowChrome() {
  const api = desktopWindowApi();
  // Windows uses the renderer-owned controls because the native frame is
  // hidden. macOS keeps Electron's native titlebar so its traffic lights stay
  // in their expected position and follow the platform's window behavior.
  const isWindows = api?.platform === "win32";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isWindows || !api) return;
    let cancelled = false;
    const request = api.getWindowState?.();
    if (request) {
      void request.then((state) => {
        if (!cancelled) setMaximized(state.maximized);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [api, isWindows]);

  useEffect(() => {
    if (!isWindows || !api?.onWindowStateChanged) return;
    return api.onWindowStateChanged((state) => setMaximized(state.maximized));
  }, [api, isWindows]);

  if (!isWindows || !api) return null;

  return (
    <div className="window-chrome" data-maximized={maximized}>
      <div className="window-chrome__controls" role="toolbar" aria-label="Window controls">
        <button
          type="button"
          className="window-chrome__button"
          aria-label="Minimize window"
          title="Minimize"
          onClick={() => void api.minimizeWindow?.()}
        >
          <Minus size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-chrome__button"
          aria-label={maximized ? "Restore window" : "Maximize window"}
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void api.toggleMaximizeWindow?.()}
        >
          {maximized ? (
            <Minimize2 size={14} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="window-chrome__button window-chrome__button--close"
          aria-label="Close window"
          title="Close"
          onClick={() => void api.closeWindow?.()}
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
