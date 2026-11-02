/** Real Chromium regression for transcript Markdown tables; no API or user data.
 * Run: node_modules/.bin/tsx scripts/markdown-table-layout-smoke.ts
 * SYNAX_CHROME_PATH can select a local Chromium executable.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const comparison = [
  "| 代码 / 发现 | 引入提交 | 是否已在 master 基线 | beta 是否“新引入” |",
  "| --- | --- | --- | --- |",
  "| `refreshState` 只写 4 列 + `detail_type='NORMAL'` | `f7be77f76` （10-20，ID1100245） | 是，但 `git grep` 全仓**无调用方**（死代码） | ❌ 不是 beta 新增（只是被重新接线） |",
  "| `recalculated()` （只回填 id/state/totalExpected） | `f7be77f76` | 是，同样无调用方 | ❌ |",
  "| `rescueReady()` + 两处调用点（[:58](https://example.test/a)、[:161](https://example.test/b)） | `3dce0ef0b` （10-29，ID1100245） | 否 | ✅ beta 新增 |",
].join("\n");
const longPath = `services/${"very-long-path/".repeat(20)}file.ts`;
const samples = {
  comparison,
  prose: `| 名称 | 描述 | 状态 |\n| --- | --- | --- |\n| 示例 | ${"这是一段需要在表格内自然换行的中文描述。".repeat(25)} | 完成 |`,
  paths: `| 名称 | 路径 | 状态 |\n| --- | --- | --- |\n| 示例 | \`${longPath}\` [${longPath}](https://example.test/file) | 完成 |`,
  many: `| ${Array.from({ length: 8 }, (_, i) => `列 ${i + 1}`).join(" | ")} |\n| ${Array(8).fill("---").join(" | ")} |\n| ${Array(8).fill("中文内容").join(" | ")} |`,
  nested: comparison.split("\n").map(line => `> ${line}`).join("\n"),
};
const entry = "/__markdown-table-test.tsx";
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { MarkdownRenderer } from '/src/shared/ui/markdown/MarkdownRenderer';
const samples = ${JSON.stringify(samples)};
createRoot(document.getElementById('root')).render(
  <main style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
    {Object.entries(samples).map(([name, content]) =>
      <section key={name} data-sample={name} className="session-answer-region">
        <MarkdownRenderer content={content} />
      </section>)}
  </main>
);
`;
const server = await createServer({
  configFile: path.resolve("client/vite.config.ts"),
  root: path.resolve("client"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, open: false },
  plugins: [{
    name: "markdown-table-fixture",
    resolveId: id => id === entry ? id : null,
    load: id => id === entry ? fixture : null,
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__markdown-table-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, `<!doctype html><html><body>
          <div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
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
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath()),
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const address = server.httpServer!.address() as { port: number };
  await page.goto(`http://127.0.0.1:${address.port}/__markdown-table-test`);
  await page.locator('[data-sample="nested"] table').waitFor();
  let checks = 0;
  for (const theme of ["light", "dark"]) {
    for (const fontSize of [14, 20]) {
      for (const width of [960, 640, 360]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(({ theme, fontSize }) => {
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.documentElement.style.setProperty("--agent-chat-font-size", `${fontSize}px`);
        }, { theme, fontSize });
        const metrics = await page.locator("[data-sample]").evaluateAll(sections => sections.map(section => {
          const scroll = section.querySelector<HTMLElement>(".markdown-table-scroll")!;
          const table = scroll.querySelector("table")!;
          const cells = [...table.querySelectorAll<HTMLElement>("th, td")];
          const size = parseFloat(getComputedStyle(cells[0]).fontSize);
          return {
            name: section.getAttribute("data-sample"),
            width: scroll.clientWidth,
            scrollWidth: scroll.scrollWidth,
            tableWidth: table.getBoundingClientRect().width,
            fontSize: size,
            minCell: Math.min(...cells.map(cell => cell.getBoundingClientRect().width)),
            maxOverflow: Math.max(...cells.map(cell => cell.scrollWidth - cell.clientWidth)),
            topAligned: cells.every(cell => getComputedStyle(cell).verticalAlign === "top"),
          };
        }));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "table must not widen the page");
        for (const m of metrics) {
          const label = `${theme}/${fontSize}px/${width}px/${m.name}`;
          assert(m.minCell >= 8 * m.fontSize - 1, `${label}: column collapsed`);
          assert(m.maxOverflow <= 2, `${label}: cell content overflowed`);
          assert(m.topAligned, `${label}: multiline cells must align at the top`);
          // Long descriptions and tokens must wrap, not produce a max-content-width table.
          assert(m.tableWidth <= Math.max(m.width, (m.name === "many" ? 8 : m.name === "prose" || m.name === "paths" ? 3 : 4) * 8 * m.fontSize) + 2,
            `${label}: unnecessary horizontal overflow (${m.tableWidth}px)`);
          if (width === 360 && m.name === "comparison") assert(m.scrollWidth > m.width, `${label}: narrow tables must scroll`);
          checks++;
        }
        console.log(`PASS ${theme}/${fontSize}px/${width}px: ${metrics.length} tables`);
      }
    }
  }
  const scroll = page.locator('[data-sample="comparison"] .markdown-table-scroll');
  await scroll.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector('[data-sample="comparison"] .markdown-table-scroll')!.scrollLeft > 0);
  assert.deepEqual(errors, []);
  console.log(`PASS ${checks} layout checks + keyboard horizontal scrolling`);
} finally {
  await browser?.close();
  await server.close();
}
