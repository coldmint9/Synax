import styles from "./runtime.css?raw";
import runtime from "./runtime.js?raw";
import icons from "./icons.json";
import iconsLicense from "./icons.LICENSE?raw";

/**
 * The CSP that governs every sandboxed interactive document. Previews are
 * conversation and panel content, so they must stay self-contained: no
 * network, no workers, no nested documents, no external base URLs.
 */
export const INTERACTIVE_CSP = [
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

export interface InteractiveDocumentConfig {
  id: string;
  token: string;
  theme: "light" | "dark";
  locale?: string;
  /** Restored `window.openai.widgetState` for a persisted preview. */
  state?: unknown;
}

/**
 * Wrap one HTML fragment into the opaque-origin document the frame runs.
 * Callers never author the shell themselves, so CSP, theme tokens and the
 * runtime contract stay identical for chat previews and embedded apps.
 */
export function interactiveDocument(
  fragment: string,
  config: InteractiveDocumentConfig,
): string {
  const data = JSON.stringify({
    id: config.id,
    token: config.token,
    theme: config.theme,
    locale: config.locale ?? "zh-CN",
    state: config.state ?? null,
    icons,
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="${config.locale ?? "zh-CN"}" data-theme="${config.theme === "dark" ? "dark" : "light"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${INTERACTIVE_CSP}">
<style>${styles}</style>
<script id="synax-interactive-config" type="application/json">${data}</script>
<script>/* ${iconsLicense} */
${runtime}</script></head><body>${fragment}</body></html>`;
}

/** Read the frame config back out of a rendered document (host and tests). */
export function readInteractiveDocumentConfig(html: string): Record<string, unknown> | null {
  const match = /id="synax-interactive-config" type="application\/json">([^<]+)</.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
