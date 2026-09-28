import { RuntimeAccessGate } from "./react/features/runtime/RuntimeAccessGate";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./react/App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "./index.css";
import "./react/design/fonts.css";
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
