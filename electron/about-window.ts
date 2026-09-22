import { BrowserWindow, app, nativeTheme, shell } from "electron";
import fs from "node:fs";
import { getResourcePath } from "./lib/data-paths.js";

const REPO_URL = "https://github.com/coldmint9/Synax";
const AUTHOR_URL = "https://github.com/coldmint9";

let aboutWindow: BrowserWindow | null = null;

function loadIconDataUrl(): string {
  try {
    const iconPath = app.isPackaged
      ? getResourcePath("icon.png")
      : getResourcePath("electron", "resources", "icon.png");
    return `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildAboutHtml(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  const rows: Array<[string, string]> = [
    ["软件版本", app.getVersion()],
    ["Electron", process.versions.electron ?? "—"],
    ["Chrome", process.versions.chrome ?? "—"],
    ["Node", process.versions.node ?? "—"],
  ];
  const versionRows = rows
    .map(
      ([label, value]) =>
        `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`,
    )
    .join("");
  const icon = loadIconDataUrl();
  const iconMarkup = icon
    ? `<img class="icon" src="${icon}" alt="" />`
    : `<div class="icon icon-fallback">S</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  :root {
    color-scheme: ${dark ? "dark" : "light"};
    --bg: ${dark ? "#0f141d" : "#f9f9f9"};
    --card: ${dark ? "#1a2233" : "#ffffff"};
    --text: ${dark ? "#e6ebf4" : "#1c2330"};
    --muted: ${dark ? "#94a3b8" : "#6b7280"};
    --border: ${dark ? "#2a3550" : "#e5e7eb"};
    --link: ${dark ? "#7dd3fc" : "#2563eb"};
    --chip-bg: ${dark ? "#243048" : "#eef2f7"};
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    cursor: default;
  }
  .panel { width: 320px; text-align: center; }
  .icon {
    width: 88px; height: 88px; border-radius: 22px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, ${dark ? "0.5" : "0.12"});
    display: block; margin: 0 auto 14px;
  }
  .icon-fallback {
    display: flex; align-items: center; justify-content: center;
    background: var(--chip-bg); color: var(--text);
    font-size: 40px; font-weight: 700;
  }
  h1 { font-size: 21px; font-weight: 700; letter-spacing: 0.2px; }
  .tagline { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .versions {
    margin: 18px auto 0; padding: 4px 14px;
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  }
  .row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; padding: 8px 0; font-size: 12.5px;
  }
  .row + .row { border-top: 1px solid var(--border); }
  .label { color: var(--muted); flex-shrink: 0; }
  .value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  .links { margin-top: 16px; font-size: 12.5px; line-height: 1.9; }
  .links .label { color: var(--muted); margin-right: 6px; }
  a { color: var(--link); text-decoration: none; user-select: text; }
  a:hover { text-decoration: underline; }
  .footer {
    margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--muted); line-height: 1.7;
  }
</style>
</head>
<body>
  <main class="panel">
    ${iconMarkup}
    <h1>Synax</h1>
    <div class="tagline">Local-first AI coding workspace</div>
    <section class="versions" aria-label="版本信息">${versionRows}</section>
    <section class="links">
      <div><span class="label">作者</span>coldmint9</div>
      <div><span class="label">GitHub</span><a href="${REPO_URL}">${REPO_URL}</a></div>
    </section>
    <footer class="footer">MIT License<br />Copyright &copy; 2026 Synax contributors</footer>
  </main>
</body>
</html>`;
}

export function showAboutWindow(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 380,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "关于 Synax",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 16 } }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f141d" : "#f9f9f9",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  aboutWindow.once("closed", () => {
    aboutWindow = null;
  });
  aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://github.com/")) void shell.openExternal(url);
    return { action: "deny" };
  });
  aboutWindow.webContents.on("will-navigate", (event) =>
    event.preventDefault(),
  );
  aboutWindow.once("ready-to-show", () => aboutWindow?.show());
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildAboutHtml())}`,
  );
}
