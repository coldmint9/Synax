import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactSdkSource } from "../../../../../../api/services/agent-runtime/artifacts/runtime-sdk";
import { runtimeDocument } from "../../../../../../api/services/agent-runtime/artifacts/policy";

/** Opt-in real Chromium component/transport QA; no server, no actual session API.
 * Run: SYNAX_ARTIFACT_BROWSER_QA=1 npx vitest run .../browser-smoke.test.ts
 * This does not substitute for the full application's publish/transcript E2E. */
describe.skipIf(process.env.SYNAX_ARTIFACT_BROWSER_QA !== "1")(
  "real browser artifact preview",
  () => {
    it("boots compiler CSP + MessageChannel, restores state, updates controls, picks an element, confirms feedback, and exports standalone", async () => {
      const body =
        '<main><h1>Checkout prototype</h1><p id="restored"></p><button data-qa-id="checkout">Continue</button><output id="quantity"></output></main>';
      const script = `(async()=>{const widget=window.synaxWidget;const initial=await widget.ready();document.getElementById('restored').textContent=initial.state.modelState?.page||'standalone';await widget.registerControls([{key:'quantity',label:'Quantity',type:'range',min:1,max:5,defaultValue:2},{key:'status',label:'Status',type:'select',defaultValue:'running',options:[{label:'Running',value:'running'},{label:'Completed',value:'completed'}]}]);widget.onControlsChange(v=>document.getElementById('quantity').textContent='Quantity '+v.quantity);document.querySelector('button').onclick=()=>widget.setState({privateState:{expanded:true},modelState:{page:'confirmed'}});})();`;
      const html = runtimeDocument(
        body,
        [script],
        [
          "body{font-family:system-ui;padding:24px;margin:0;color:var(--synax-fg);background:var(--synax-bg)}h1{font-size:22px}button{border:0;border-radius:8px;padding:10px 18px;background:#24242b;color:white}output{display:block;padding-top:16px}",
        ],
        artifactSdkSource(),
      );
      const frontend = path.resolve(
        "src/react/features/artifacts/ArtifactCard.tsx",
      );
      const api = path.resolve("src/lib/api/artifacts.ts");
      const bundle = await build({
        stdin: {
          contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ArtifactCard} from ${JSON.stringify(frontend)};import {artifactsApi} from ${JSON.stringify(api)};
      const reference={type:'artifact',artifactId:'a',revisionId:'r',title:'Checkout prototype',presentation:'inline'};
      const revision={...reference,sessionId:'s',revisionNumber:1,sourceKind:'html',sourcePath:'index.html',status:'ready',diagnostics:[]};
      let saved={privateState:{secret:'PRIVATE_SECRET'},modelState:{page:'cart restored'},controls:{},etag:1,schemaVersion:1};
      Object.assign(artifactsApi,{bundle:async()=>({revision,html:${JSON.stringify(html)}}),state:async()=>saved,revisions:async()=>({items:[revision]}),source:async()=>({files:[]}),saveState:async(s,r,state)=>(saved={...state,etag:state.etag+1}),feedback:async(s,r,input)=>{window.submitted=input;return {feedbackId:'f',message:'queued',submitted:true}}});
      createRoot(document.getElementById('root')).render(<ArtifactCard sessionId="s" reference={reference}/>);`,
          resolveDir: process.cwd(),
          loader: "tsx",
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
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), "synax-artifact-qa-"),
      );
      try {
        const page = await browser.newPage({
          viewport: { width: 850, height: 900 },
        });
        page.setDefaultTimeout(6000);
        const errors: string[] = [];
        page.on("pageerror", (error) => {
          errors.push(error.message);
          console.error("Preview page error:", error.message);
        });
        page.on("console", (msg) => {
          if (msg.type() === "error")
            console.error("Preview console:", msg.text());
        });
        await page.setContent(
          '<html lang="en"><head></head><body style="margin:0;background:#f7f7f9;font-family:system-ui"><div id="root" style="max-width:720px;margin:24px auto;padding:0 12px"></div></body></html>',
        );
        // setContent about:blank isn't a secure context, so supply UUID from Playwright's host.
        await page.addScriptTag({
          content:
            'if(!crypto.randomUUID)crypto.randomUUID=()=>"00000000-0000-4000-8000-"+String(Math.random()).slice(2,14).padEnd(12,"0");',
        });
        await page.addStyleTag({
          content: await fs.readFile(
            path.resolve("src/react/features/artifacts/artifacts.css"),
            "utf8",
          ),
        });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page
          .getByRole("button", { name: "Run interactive content" })
          .waitFor();
        await page.screenshot({ path: path.join(dir, "opt-in.png") });
        expect(await page.locator("iframe").count()).toBe(0);
        await page
          .getByRole("button", { name: "Run interactive content" })
          .click();
        const frame = page.frameLocator("iframe");
        await frame.getByText("cart restored").waitFor();
        await page.waitForFunction(() => {
          const height = document
            .querySelector("iframe")
            ?.getBoundingClientRect().height;
          return height !== undefined && height >= 96 && height < 380;
        });
        const intrinsicHeight = await page
          .locator(".artifact-preview-stage")
          .evaluate((node) => parseFloat((node as HTMLElement).style.height));
        await page.getByRole("tab", { name: "QA", exact: true }).click();
        const range = page.getByRole("slider", { name: "Quantity" });
        await range.waitFor();
        await range.fill("4");
        await page
          .getByRole("combobox", { name: "Status", exact: true })
          .selectOption("completed");
        // Hidden-frame responses must continue past the SDK request timeout.
        await page.waitForTimeout(6200);
        expect(errors).toEqual([]);
        expect(
          await page
            .locator(".artifact-preview-stage")
            .evaluate((node) => parseFloat((node as HTMLElement).style.height)),
        ).toBe(intrinsicHeight);
        await page.getByRole("button", { name: "Pick an element" }).click();
        await frame.getByText("Quantity 4").waitFor();
        await frame.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("tab", { name: "QA", exact: true }).click();
        await page.getByText('[data-qa-id="checkout"]').waitFor();
        await page
          .getByRole("textbox", { name: "What should change?" })
          .fill("Make the checkout action clearer.");
        await page.screenshot({ path: path.join(dir, "qa.png") });
        await page.getByRole("button", { name: "Review feedback" }).click();
        expect(await page.getByRole("dialog").innerText()).not.toContain(
          "PRIVATE_SECRET",
        );
        expect(await page.evaluate(() => !!(window as any).submitted)).toBe(
          false,
        );
        await page.screenshot({ path: path.join(dir, "confirm.png") });
        await page.getByRole("button", { name: "Confirm and send" }).click();
        await page.getByText("Feedback queued for the agent.").waitFor();
        expect(
          await page.evaluate(
            () => (window as any).submitted.parameters.quantity,
          ),
        ).toBe(4);
        await page.getByRole("tab", { name: "Preview", exact: true }).click();
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        await page
          .getByRole("button", { name: "Run interactive content" })
          .click();
        await frame.getByText("cart restored").waitFor();
        // Real compiler HTML export runs with no injected credentials or host channel.
        const standalone = await browser.newPage();
        await standalone.setContent(html);
        await standalone.getByText("standalone", { exact: true }).waitFor();
        expect(
          await standalone.evaluate(() =>
            Object.keys((window as any).synaxWidget.getState().controls),
          ),
        ).toEqual(["quantity", "status"]);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(dir, "narrow.png") });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
        console.log(`Artifact Chromium QA screenshots: ${dir}`);
      } finally {
        await browser.close();
      }
    }, 30000);
  },
);
