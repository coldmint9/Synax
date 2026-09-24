/** Real Chromium regression: hidden ask inputs must scroll with their visible labels.
 * Run: npx tsx scripts/ask-selection-scroll-smoke.ts (no API or user data).
 */
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const entry = "/__ask-selection-test.tsx";
const fixture = `
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { InteractionCard } from '/src/react/features/agent-workspace/AgentInteractionPanel';
import { useTranscriptScroll } from '/src/react/features/agent-workspace/useTranscriptScroll';
const type = new URLSearchParams(location.search).get('type');
const interaction = {
  id: 'ask-scroll', sessionId: 'fixture', runId: 'run', stepId: 'step', toolCallId: 'tool',
  kind: 'clarification', revision: 1, status: 'pending', response: null, createdAt: '', resolvedAt: null,
  request: { title: 'Ask scroll regression', questions: [{ id: 'scenario', type, label: 'Scenario',
    required: true, allowOther: true,
    options: [1,2,3].map(n => ({ value: String(n), label: 'Choice ' + n })) }] }
};
function App() {
  const ref = useRef(null);
  useTranscriptScroll(ref, 'fixture');
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div data-host style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ position: 'relative', height: '100%' }}>
        <div ref={ref} data-scroll style={{ height: '100%', overflowY: 'auto' }}>
          <div style={{ maxWidth: 750, margin: 'auto' }}>
            <div style={{ height: 1200 }}>Earlier messages</div>
            <InteractionCard interaction={interaction} />
          </div>
        </div>
      </div>
    </div>
    <div style={{ height: 120, flexShrink: 0 }}>Composer</div>
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
`;
const server = await createServer({
  configFile: path.resolve("web/vite.config.ts"),
  root: path.resolve("web"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, open: false },
  plugins: [{
    name: "ask-scroll-fixture",
    resolveId: (id) => id === entry ? id : null,
    load: (id) => id === entry ? fixture : null,
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__ask-selection-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__ask-selection-test", `
          <!doctype html><html class="dark"><body><div id="root"></div>
          <script type="module" src="${entry}"></script></body></html>`));
      });
    },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SYNAX_CHROME_PATH ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : chromium.executablePath()),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => console.error(error.message));
  const address = server.httpServer!.address() as { port: number };
  for (const type of ["single_select", "multi_select", "boolean"]) {
    await page.goto(`http://127.0.0.1:${address.port}/__ask-selection-test?type=${type}`);
    const labels = page.locator(".agent-request-choice");
    await labels.first().waitFor();
    await page.locator(".session-inline-interaction").scrollIntoViewIfNeeded();
    const before = await page.locator(".session-inline-interaction").boundingBox();
    assert(before);
    const hostTop = await page.locator("[data-host]").evaluate(el => el.scrollTop);
    const checkPosition = async () => {
      const after = await page.locator(".session-inline-interaction").boundingBox();
      assert(after && Math.abs(after.y - before.y) < 2, `${type}: selecting moved the ask card from ${before.y} to ${after?.y}`);
      assert.equal(await page.locator("[data-host]").evaluate(el => el.scrollTop), hostTop, `${type}: focus scrolled the outer container`);
    };
    for (const index of [1, 0]) {
      await labels.nth(index).click();
      assert(await labels.nth(index).locator("input").isChecked());
      await checkPosition();
    }
    // Keyboard selection must retain native focus and remain visible too.
    await page.keyboard.press(type === "multi_select" ? "Tab" : "ArrowDown");
    if (type === "multi_select") await page.keyboard.press("Space");
    assert(await labels.nth(1).locator("input").evaluate(el => el === document.activeElement));
    assert.equal(await labels.nth(1).locator("input").isChecked(), type !== "multi_select");
    await checkPosition();
    if (type !== "boolean") {
      await labels.last().click();
      assert(await labels.last().locator("input").isChecked());
      assert.equal(await page.locator("[data-host]").evaluate(el => el.scrollTop), hostTop);
      await page.locator('.agent-request-input').fill('Another scenario');
    }
    console.log(`PASS ${type}: mouse, keyboard, and focus stay in the transcript`);
  }
} finally {
  await browser?.close();
  await server.close();
}
