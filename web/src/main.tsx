import { RuntimeAccessGate } from "./react/features/runtime/RuntimeAccessGate";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { RouterProvider } from "@heroui/react";
import { useDesktopAppearance } from "./react/state/desktopAppearanceStore";
import App from "./react/App";
import "./index.css";
import {
  hydrateShellPreferences,
  startProjectRecovery,
  startShellAppearance,
} from "./react/state/shellStore";
import { initApiOrigin } from "./lib/api/originConfig";
import { startApiConnectivityMonitor } from "./lib/apiConnectivity";
import { installScrollRevealScrollbar } from "./lib/scrollRevealScrollbar";

hydrateShellPreferences();
installScrollRevealScrollbar();
const stopAppearance = startShellAppearance();
if (import.meta.hot) import.meta.hot.dispose(stopAppearance);

function HeroUIRouter({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return <RouterProvider navigate={navigate}>{children}</RouterProvider>;
}

async function bootstrap() {
  await Promise.all([initApiOrigin(), useDesktopAppearance.getState().load()]);
  startProjectRecovery();
  startApiConnectivityMonitor();
  ReactDOM.createRoot(document.getElementById("app")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <HeroUIRouter>
          <RuntimeAccessGate>
            <App />
          </RuntimeAccessGate>
        </HeroUIRouter>
      </BrowserRouter>
    </React.StrictMode>,
  );
}

bootstrap();
