/** Explicit opt-in native transport fixture. Not imported by the application. */
import { app, BrowserWindow, protocol } from "electron";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ArtifactPreviewManager } from "./manager.js";
import { ARTIFACT_SCHEME } from "./policy.js";
protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } },
]);
void app.whenReady().then(async () => {
  const owner = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: fileURLToPath(new URL("../../preload.js", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const manager = new ArtifactPreviewManager(
    fileURLToPath(new URL("../../artifact-preload.js", import.meta.url)),
    () => owner,
    (url) => url.startsWith("data:text/html,"),
  );
  manager.registerIPC();
  Object.assign(globalThis, { artifactSmoke: { owner, manager, writeFile } });
  await owner.loadURL(
    'data:text/html,<body style="margin:0;background:rgb(0,0,255)"><h1>Artifact native transport fixture</h1></body>',
  );
  owner.show();
  owner.focus();
  app.on("before-quit", () => manager.dispose());
});
