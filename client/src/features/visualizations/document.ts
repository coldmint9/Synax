import styles from "./runtime.css?raw";
import runtime from "./runtime.js?raw";
import visualizationIcons from "./icons.json";
import iconsLicense from "./icons.LICENSE?raw";

export const VISUALIZATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface VisualizationConfig {
  id: string;
  token: string;
  theme: "light" | "dark";
}

export function visualizationDocument(
  fragment: string,
  config: VisualizationConfig,
): string {
  const data = JSON.stringify({ ...config, icons: visualizationIcons }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html><html data-theme="${config.theme === "dark" ? "dark" : "light"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP}">
<style>${styles}</style>
<script id="synax-visualization-config" type="application/json">${data}</script>
<script>/* ${iconsLicense} */
${runtime}</script></head><body>${fragment}</body></html>`;
}
