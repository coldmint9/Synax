import { RuntimeAccessGate } from "./react/features/runtime/RuntimeAccessGate";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { RouterProvider } from "@/react/components/ui";
import App from "./react/App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./index.css";
import "katex/dist/katex.min.css";
import {
  hydrateShellPreferences,
  startShellAppearance,
} from "./react/state/shellStore";
import { installScrollRevealScrollbar } from "./lib/scrollRevealScrollbar";

hydrateShellPreferences();
installScrollRevealScrollbar();
const stopAppearance = startShellAppearance();
if (import.meta.hot) import.meta.hot.dispose(stopAppearance);

function SynaxUIRouter({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return <RouterProvider navigate={navigate}>{children}</RouterProvider>;
}

function bootstrap() {
  ReactDOM.createRoot(document.getElementById("app")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <SynaxUIRouter>
          <RuntimeAccessGate>
            <App />
          </RuntimeAccessGate>
        </SynaxUIRouter>
      </BrowserRouter>
    </React.StrictMode>,
  );
}

bootstrap();
