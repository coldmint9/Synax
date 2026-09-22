/** Native Electron sandbox regression. Uses the real preview component and production preload, not the full application bootstrap. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  _electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";

const temp = await fs.mkdtemp(
  path.join(os.tmpdir(), "synax-visualization-native-"),
);
const output = path.resolve("out/visualization-native-smoke");
await fs.mkdir(output, { recursive: true });
const fixture = await fs.readFile(
  "web/src/react/features/visualizations/__tests__/fixtures/approved-demo.html",
  "utf8",
);
const hostCss = await fs.readFile(
  "web/src/react/features/visualizations/visualizations.css",
  "utf8",
);
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {InlineVisualization} from './src/react/features/visualizations/InlineVisualization';const root=createRoot(document.getElementById('root'));window.renderPreview=(html=${JSON.stringify(fixture)},id='preview')=>root.render(<InlineVisualization visualization={{id,html}}/>);window.removePreview=()=>root.render(null);window.renderPreview();`,
    resolveDir: path.resolve("web"),
    loader: "tsx",
  },
  write: false,
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "raw-runtime",
      setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "raw-runtime",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "raw-runtime" },
          async (args) => ({
            contents: await fs.readFile(args.path, "utf8"),
            loader: "text",
          }),
        );
      },
    },
  ],
});
const htmlPath = path.join(temp, "index.html");
await fs.writeFile(
  htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="frame-src 'none'; object-src 'none'"><style>body{margin:20px}#root{max-width:736px}${hostCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
);
const mainPath = path.join(temp, "main.cjs");
await fs.writeFile(
  mainPath,
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:820,height:1000,show:false,webPreferences:{preload:${JSON.stringify(path.resolve("dist-electron/preload.js"))},contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webviewTag:false}});win.loadFile(${JSON.stringify(htmlPath)});});app.on('window-all-closed',()=>app.quit());`,
);
let app: ElectronApplication | undefined, page: Page | undefined;
try {
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await _electron.launch({
    ...(env.SYNAX_ELECTRON_PATH
      ? { executablePath: env.SYNAX_ELECTRON_PATH }
      : {}),
    args: [mainPath, `--user-data-dir=${path.join(temp, "profile")}`],
    env,
    timeout: 30_000,
  });
  page = await app.firstWindow();
  const card = page.locator(".inline-visualization");
  await card.locator("iframe").waitFor();
  const inner = card.frameLocator("iframe");
  await inner.getByRole("button", { name: "Explore workspace" }).click();
  await inner
    .locator("[data-progress-value]")
    .filter({ hasText: "78%" })
    .waitFor();
  const handle = await card.locator("iframe").elementHandle();
  const frame = (await handle!.contentFrame())!;
  assert.equal(
    await page.evaluate(() => typeof (window as any).electronAPI),
    "object",
  );
  assert.equal(
    await frame.evaluate(() => typeof (window as any).electronAPI),
    "undefined",
  );
  assert.equal(
    await frame.evaluate(() => typeof (window as any).require),
    "undefined",
  );
  assert.equal(
    await frame.evaluate(() => typeof (window as any).process),
    "undefined",
  );
  assert.equal(
    await frame.evaluate(() => {
      try {
        return !!parent.document;
      } catch {
        return false;
      }
    }),
    false,
  );
  assert.equal(
    await frame.evaluate(() => {
      try {
        localStorage.setItem("leak", "x");
        return true;
      } catch {
        return false;
      }
    }),
    false,
  );
  let requests = 0,
    downloads = 0;
  page.on("request", (request) => {
    if (request.url().includes("127.0.0.1:9")) requests++;
  });
  page.on("download", () => {
    downloads++;
  });
  assert.equal(
    await frame.evaluate(async () => {
      try {
        await fetch("http://127.0.0.1:9/escape");
        return true;
      } catch {
        return false;
      }
    }),
    false,
  );
  await frame.evaluate(() => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["test"]));
    a.download = "test.txt";
    document.body.append(a);
    a.click();
  });
  assert.equal(downloads, 0);
  assert.equal(requests, 0);
  await card.screenshot({ path: path.join(output, "preview.png") });
  await page.evaluate(() => (window as any).removePreview());
  await page.waitForFunction(() => !document.querySelector("iframe"));
  await page.evaluate(() => (window as any).renderPreview());
  await inner
    .locator("[data-progress-value]")
    .filter({ hasText: "72%" })
    .waitFor();
  await page.evaluate(() =>
    (window as any).renderPreview(
      '<div>Invalid demo</div><script>throw new Error("test")<\/script>',
      "error",
    ),
  );
  await card.getByRole("alert").waitFor();
  assert.equal(await card.locator("iframe").count(), 0);
  await fs.writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        checks: [
          "real component + production preload",
          "click and styles",
          "no child Electron/Node/host DOM/storage access",
          "no fetch or download",
          "unmount cleanup, fresh instance state, runtime error UI",
        ],
        scope: "Native sandbox smoke, not packaged full-application acceptance",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS native Electron visualization sandbox, interaction, cleanup and errors",
  );
} catch (error) {
  await fs.writeFile(path.join(output, "failure.txt"), String(error));
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
