import { RuntimeAccessGate } from "../features/runtime/RuntimeAccessGate";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "../index.css";
import "../shared/design/fonts.css";
import "katex/dist/katex.min.css";
import { hydrateShellPreferences } from "../shared/state/shellStore";
import {
  hydrateThemePreferences,
  startThemeRuntime,
} from "../shared/state/themeStore";
import { installScrollRevealScrollbar } from "../shared/lib/scrollRevealScrollbar";

hydrateThemePreferences();
hydrateShellPreferences();
installScrollRevealScrollbar();
const stopThemeRuntime = startThemeRuntime();
if (import.meta.hot) import.meta.hot.dispose(stopThemeRuntime);

function bootstrap() {
  ReactDOM.createRoot(document.getElementById("app")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <RuntimeAccessGate>
          <App />
        </RuntimeAccessGate>
      </BrowserRouter>
    </React.StrictMode>,
  );
}

bootstrap();
