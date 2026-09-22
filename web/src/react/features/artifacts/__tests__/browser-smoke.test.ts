import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import { artifactSdkSource } from "../../../../../../api/services/agent-runtime/artifacts/runtime-sdk";
import { runtimeDocument } from "../../../../../../api/services/agent-runtime/artifacts/policy";

describe.skipIf(process.env.SYNAX_ARTIFACT_BROWSER_QA !== "1")(
  "minimal prototype browser",
  () => {
    it("renders directly, preserves isolation, shows hover title, interacts and resets on remount", async () => {
      const html = runtimeDocument(
        '<button id="counter">Count 0</button>',
        [
          "let n=0;document.querySelector('button').onclick=()=>document.querySelector('button').textContent='Count '+(++n);window.readyInfo=window.synaxWidget.ready();",
        ],
        [
          "body{margin:0;padding:32px;font:14px system-ui;background:var(--synax-bg);color:var(--synax-fg)}button{padding:12px 20px;border:0;border-radius:8px;background:#5145e5;color:white}",
        ],
        artifactSdkSource(),
      );
      const bundle = await build({
        stdin: {
          contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {InteractivePrototypeCard} from ${JSON.stringify(path.resolve("src/react/features/artifacts/InteractivePrototypeCard.tsx"))};const p={id:'message:hash',title:'水平导航栏 Demo',sourceKind:'html',html:${JSON.stringify(html)}};const root=createRoot(document.getElementById('root'));window.renderDemo=(id='one')=>root.render(<InteractivePrototypeCard key={id} prototype={p}/>);window.renderDemo();`,
          resolveDir: process.cwd(),
          loader: "tsx",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        loader: { ".css": "empty" },
        define: { "process.env.NODE_ENV": '"production"' },
      });
      const browser = await chromium.launch({
        executablePath:
          process.env.SYNAX_CHROME_PATH ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
      });
      const out = path.resolve("../.tmp/prototype-qa");
      await fs.mkdir(out, { recursive: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 850, height: 640 },
        });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.setContent(
          '<html lang="zh"><body style="margin:0;background:#f5f6f8;font-family:system-ui"><div id="root" style="max-width:720px;margin:48px auto;padding:0 16px"></div></body></html>',
        );
        await page.addStyleTag({
          content: await fs.readFile(
            path.resolve("src/react/features/artifacts/artifacts.css"),
            "utf8",
          ),
        });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const frame = page.frameLocator("iframe");
        await frame.getByRole("button", { name: "Count 0" }).waitFor();
        expect(await page.locator("iframe").getAttribute("sandbox")).toBe(
          "allow-scripts",
        );
        expect(
          await page
            .locator(
              ".prototype-card button,.prototype-card select,[role=tablist]",
            )
            .count(),
        ).toBe(0);
        const title = page.locator(".prototype-card-title");
        expect(await title.evaluate((e) => getComputedStyle(e).opacity)).toBe(
          "0",
        );
        const before = await page.locator(".prototype-card").boundingBox();
        await page.screenshot({ path: path.join(out, "card.png") });
        await page.locator(".prototype-card-header").hover();
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector(".prototype-card-title")!)
              .opacity === "1",
        );
        expect(
          (await page.locator(".prototype-card").boundingBox())?.height,
        ).toBe(before?.height);
        await page.screenshot({ path: path.join(out, "hover.png") });
        await frame.getByRole("button", { name: "Count 0" }).click();
        await frame.getByRole("button", { name: "Count 1" }).waitFor();
        expect(
          await frame
            .locator("body")
            .evaluate(() => Object.keys((window as any).synaxWidget).sort()),
        ).toEqual(["onThemeChange", "ready", "reportHeight"]);
        await page.evaluate(
          () => (document.documentElement.dataset.theme = "dark"),
        );
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === "dark",
        );
        await frame.locator("html[data-theme=dark]").waitFor();
        await page.evaluate(() => (window as any).renderDemo("two"));
        await frame.getByRole("button", { name: "Count 0" }).waitFor();
        await page.setViewportSize({ width: 390, height: 700 });
        await page.screenshot({ path: path.join(out, "mobile.png") });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 30000);
  },
);
