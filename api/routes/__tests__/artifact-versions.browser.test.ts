import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { agentArtifactRoutes } from "../agent-artifacts.js";
import { artifactVersionRoutes } from "../artifact-versions.js";
import { agentSessionRuntime } from "../../services/agent-runtime/session-runtime.js";
import { agentRuntimeStore } from "../../services/agent-runtime/session-store.js";
import { publishSessionArtifact } from "../../services/agent-runtime/artifact-integration.js";
import {
  getArtifactState,
  getArtifactSource,
  listRevisions,
  saveArtifactState,
} from "../../services/agent-runtime/artifacts/store.js";
import {
  getControlSchema,
  getArtifactVersionHistory,
} from "../../services/agent-runtime/artifact-versions.js";
import { setSessionWorkspaceRoot } from "../../services/agent-runtime/tools/workspace.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "../../services/agent-runtime/__tests__/agent-runtime-fixtures.js";
vi.mock("../../services/agent-runtime/run-coordinator.js", () => ({
  runCoordinator: { dispatchQueuedInput: vi.fn() },
}));

/** Real Chromium + real Hono routes/SQLite, with actual API helper and runtime-host schema hook.
 * Standalone component integration QA, not a substitute for full transcript-app acceptance.
 * SYNAX_ARTIFACT_BROWSER_QA=1 npx vitest run api/routes/__tests__/artifact-versions.browser.test.ts
 */
it.skipIf(process.env.SYNAX_ARTIFACT_BROWSER_QA !== "1").each([1, 2])(
  "branches historical content and confirms compatible v%s inheritance through real browser HTTP",
  async (schemaVersion) => {
    resetAgentRuntimeFixtures();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "artifact-versions-browser-"),
    );
    const sessionId = agentSessionRuntime.create(executorInput).id;
    setSessionWorkspaceRoot(sessionId, root);
    await fs.writeFile(
      path.join(root, "index.html"),
      "<h1>Historical snapshot</h1>",
    );
    const one = await publishSessionArtifact(sessionId, {
      title: "Historical demo",
      sourcePath: "index.html",
      sourceKind: "html",
      idempotencyKey: "one",
    });
    await fs.writeFile(
      path.join(root, "index.html"),
      "<h1>Current snapshot</h1>",
    );
    const two = await publishSessionArtifact(sessionId, {
      title: "Historical demo",
      sourcePath: "index.html",
      sourceKind: "html",
      idempotencyKey: "two",
      artifactId: one.artifactId,
      baseRevisionId: one.revisionId,
    });
    saveArtifactState(
      sessionId,
      one.revisionId,
      {
        schemaVersion,
        controls: { size: 7 },
        privateState: { secret: "NEVER_DISPLAY_PRIVATE" },
        modelState: { page: "NEVER_DISPLAY_MODEL" },
      },
      0,
    );
    const frontend = path.resolve(
      "web/src/react/features/artifacts/ArtifactVersions.tsx",
    );
    const host = path.resolve(
      "web/src/react/features/artifacts/runtime-host.ts",
    );
    const api = path.resolve("web/src/lib/api/artifacts.ts");
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import {VersionActions} from ${JSON.stringify(frontend)};
      import {ArtifactRuntimeHost} from ${JSON.stringify(host)};
      import {artifactsApi} from ${JSON.stringify(api)};
      const sessionId=${JSON.stringify(sessionId)}, one=${JSON.stringify(one)}, two=${JSON.stringify(two)};
      const controls=[{key:'size',label:'Size',type:'range',defaultValue:2,min:1,max:10}];
      (async()=>{for(const revision of [one,two]){
        const runtime=new ArtifactRuntimeHost({sessionId,revisionId:revision.revisionId,state:await artifactsApi.state(sessionId,revision.revisionId),onState:()=>{},onControls:()=>{},onDraft:()=>{},onHeight:()=>{},onError:message=>{throw new Error(message)},send:()=>{}});
        await runtime.handle('controls',${schemaVersion}===1?controls:{controls,schemaVersion:${schemaVersion}});runtime.dispose();
      }
      createRoot(document.getElementById('root')).render(<div className="artifact-card"><VersionActions sessionId={sessionId} reference={two} onForkPublished={revision=>{window.publishedFork=revision}} onStateInherited={state=>{window.inheritedState=state}}/></div>);
      })().catch(error=>{document.body.textContent=error.stack;throw error});`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env": "{}",
      },
      plugins: [
        {
          name: "qa-locale",
          setup(build) {
            build.onLoad({ filter: /useLocale\.ts$/ }, () => ({
              contents: 'export function useLocale(){return {locale:"en"}}',
              loader: "ts",
            }));
          },
        },
      ],
    });
    const css = await fs.readFile(
      path.resolve("web/src/react/features/artifacts/artifacts.css"),
      "utf8",
    );
    const app = new Hono();
    app.route("/api/agent-runtime", agentArtifactRoutes);
    app.route("/api/agent-runtime", artifactVersionRoutes);
    app.get("/", (c) =>
      c.html(
        `<html lang="en"><head><meta charset="utf-8"><style>body{margin:24px;background:#f7f7f9;font-family:system-ui}#root{max-width:760px;margin:auto}${css}</style></head><body><div id="root"></div><script src="/component.js"></script></body></html>`,
      ),
    );
    app.get("/component.js", (c) =>
      c.body(bundle.outputFiles[0].text, 200, {
        "Content-Type": "application/javascript",
      }),
    );
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    if (!server.listening)
      await new Promise<void>((resolve) => server.once("listening", resolve));
    const browser = await chromium.launch({
      executablePath:
        process.env.SYNAX_CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 850, height: 850 },
      });
      page.setDefaultTimeout(6000);
      page.on("console", (message) => {
        if (message.type() === "error") console.error(message.text());
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error(error.message);
      });
      await page.goto(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
      await page
        .getByRole("combobox", { name: "Source version" })
        .selectOption(one.revisionId);
      expect(getControlSchema(sessionId, one.revisionId)?.controls[0].key).toBe(
        "size",
      );
      await fs.unlink(path.join(root, "index.html"));
      await page
        .getByRole("button", { name: "Branch from selected version" })
        .click();
      await page
        .getByRole("textbox", { name: "Branch title" })
        .fill("Saved historical branch");
      await page.getByRole("button", { name: "Publish new branch" }).click();
      await page.waitForFunction(() => !!(window as any).publishedFork);
      const fork = await page.evaluate(() => (window as any).publishedFork);
      expect(
        getArtifactSource(sessionId, fork.revisionId)[0].content,
      ).toContain("Historical snapshot");
      expect(
        getArtifactVersionHistory(sessionId, fork.artifactId).derivedFrom
          ?.revisionId,
      ).toBe(one.revisionId);
      expect(listRevisions(sessionId, one.artifactId)).toEqual([two, one]);
      expect(getArtifactState(sessionId, fork.revisionId)).toMatchObject({
        schemaVersion,
        etag: schemaVersion === 1 ? 0 : 1,
        controls: {},
        privateState: null,
        modelState: null,
      });
      await page
        .getByRole("button", { name: "Review state inheritance" })
        .click();
      await page
        .getByRole("button", { name: "Confirm state inheritance" })
        .waitFor();
      expect(
        await page
          .getByRole("checkbox", { name: "Also copy private state" })
          .isChecked(),
      ).toBe(false);
      expect(await page.textContent("body")).not.toContain("NEVER_DISPLAY");
      await fs.mkdir(".tmp/artifact-qa", { recursive: true });
      await page.screenshot({
        path: `.tmp/artifact-qa/version-v${schemaVersion}-inheritance-review.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Confirm state inheritance" })
        .click();
      await page.waitForFunction(() => !!(window as any).inheritedState);
      expect(getArtifactState(sessionId, two.revisionId)).toMatchObject({
        schemaVersion,
        controls: { size: 7 },
        privateState: null,
        modelState: null,
      });
      expect(
        agentRuntimeStore
          .listMessages(sessionId)
          .filter((m) => m.metadata?.source === "artifact_publisher"),
      ).toHaveLength(3);
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 380, height: 850 });
      await page.screenshot({
        path: `.tmp/artifact-qa/version-v${schemaVersion}-branch-mobile.png`,
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
