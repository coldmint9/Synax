import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { compileArtifact } from "../compiler.js";
import { readSnapshot } from "../snapshot.js";
const executablePath = [
  process.env.SYNAX_ARTIFACT_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
// Browser assertions run where a real browser is installed; never substitute a DOM shim.
describe.runIf(Boolean(executablePath))("real offline artifact browser", () => {
  let browser: Browser, root: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-browser-"));
    browser = await chromium.launch({ executablePath, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("runs local HTML interactions and blocks connect-src without a host", async () => {
    fs.writeFileSync(
      path.join(root, "index.html"),
      `<button id="counter" style="color:red">0</button><script>const sharedValue=42;function sharedFunction(){return sharedValue}</script><script>
      window.bootstrapPresent=!!window.synaxWidget;window.sharedScriptValue=sharedFunction();
      document.querySelector('#counter').addEventListener('click',()=>document.querySelector('#counter').textContent='1');
      fetch('https://artifact-egress.invalid/secret').then(()=>window.blocked=false,()=>window.blocked=true);
    </script>`,
    );
    const result = await compileArtifact(
      readSnapshot(root, "index.html"),
      "html",
    );
    fs.writeFileSync(path.join(root, "preview.html"), result.html);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let network = 0;
    await page.route("https://artifact-egress.invalid/**", (route) => {
      network++;
      return route.abort();
    });
    await page.goto(pathToFileURL(path.join(root, "preview.html")).href);
    await page.waitForFunction("window.blocked===true");
    expect(await page.evaluate("window.bootstrapPresent")).toBe(false);
    expect(await page.evaluate("window.sharedScriptValue")).toBe(42);
    await page.getByRole("button", { name: "0" }).click();
    expect(await page.getByRole("button").textContent()).toBe("1");
    expect(
      await page
        .getByRole("button")
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(255, 0, 0)");
    expect(network).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });
  it("runs TSX with real React and retains interaction under hash-only CSP", async () => {
    fs.writeFileSync(
      path.join(root, "app.tsx"),
      `import React from 'react';export default function App(){const [n,setN]=React.useState(0);return <button style={{color:'blue'}} onClick={()=>setN(n+1)}>Count {n}</button>}`,
    );
    const result = await compileArtifact(
      readSnapshot(root, "app.tsx"),
      "react",
    );
    fs.writeFileSync(path.join(root, "react.html"), result.html);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root, "react.html")).href);
    await page.getByRole("button", { name: "Count 0" }).click();
    await page.getByRole("button", { name: "Count 1" }).waitFor();
    expect(
      await page
        .getByRole("button")
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(0, 0, 255)");
    expect(errors).toEqual([]);
    await page.close();
  });
  it("renders and updates a D3 bar chart entirely offline under the unchanged CSP", async () => {
    fs.writeFileSync(
      path.join(root, "chart.html"),
      `<svg aria-label="D3 chart" width="240" height="100"></svg><button>Update chart</button><script type="module">
      import {select,scaleLinear} from 'd3';
      const scale=scaleLinear().domain([0,10]).range([0,200]);
      const bars=select('svg').selectAll('rect').data([2,5,10]).join('rect').attr('x',0).attr('y',(_,i)=>i*30).attr('height',20).attr('width',scale).attr('fill','teal');
      select('button').on('click',()=>bars.data([3,6,9]).attr('width',scale));
    </script>`,
    );
    const result = await compileArtifact(
      readSnapshot(root, "chart.html"),
      "html",
    );
    expect(result.dependencies.find((dep) => dep.name === "d3")?.version).toBe(
      "7.9.0",
    );
    expect(result.html).not.toContain("'unsafe-eval'");
    fs.writeFileSync(path.join(root, "chart-preview.html"), result.html);
    const page = await browser.newPage();
    const errors: string[] = [];
    let remoteRequests = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/^https?:/, (route) => {
      remoteRequests++;
      return route.abort();
    });
    await page.goto(pathToFileURL(path.join(root, "chart-preview.html")).href);
    const bars = page.locator("svg rect");
    await bars.first().waitFor();
    expect(
      await bars.evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("width")),
      ),
    ).toEqual(["40", "100", "200"]);
    await page.getByRole("button", { name: "Update chart" }).click();
    expect(
      await bars.evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("width")),
      ),
    ).toEqual(["60", "120", "180"]);
    expect(remoteRequests).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("supplies real Lucide icons to classic HTML without a network or React renderer", async () => {
    fs.writeFileSync(
      path.join(root, "icons.html"),
      '<i data-lucide="git-branch" aria-label="Branch icon"></i><button id="add">Add icon</button><script>document.getElementById("add").addEventListener("click",()=>{const el=document.createElement("i");el.dataset.lucide="folder";document.body.append(el);window.lucide.createIcons();});</script>',
    );
    const result = await compileArtifact(
      readSnapshot(root, "icons.html"),
      "html",
    );
    fs.writeFileSync(path.join(root, "icons-preview.html"), result.html);
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(root, "icons-preview.html")).href);
    await page.locator('svg[data-lucide-icon="git-branch"]').waitFor();
    expect(
      await page.locator('svg[data-lucide-icon="git-branch"] circle').count(),
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Add icon" }).click();
    await page.locator('svg[data-lucide-icon="folder"]').waitFor();
    await page.close();
  });
});
