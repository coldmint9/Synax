import http from "node:http";
import { browserTools } from "../api/services/agent-runtime/tools/browser/browser-tools.js";
import { closeAllBrowserSessions } from "../api/services/agent-runtime/tools/browser/browser-manager.js";

const server = http.createServer((req, res) => {
  if (req.url === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "smoke-check" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Synax Smoke</title></head><body>
    <h1>Synax Smoke</h1>
    <button id="go">Click me</button>
    <input id="name" placeholder="Type here"/>
    <p id="out"></p>
    <script>
      console.error("smoke-console-error");
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('out').textContent = 'clicked';
      });
      fetch("/api/ping").then(r => r.json()).catch(() => {});
    </script>
  </body></html>`);
});
await new Promise<void>((resolve) => server.listen(8931, "127.0.0.1", () => resolve()));

const input = (args: unknown) => ({
  sessionId: "smoke",
  runId: null,
  stepId: null,
  toolCallId: "tc_smoke",
  toolId: "browser",
  category: "read" as const,
  mutability: "read" as const,
  args,
});

const tool = (id: string) => {
  const found = browserTools.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

try {
  const nav = await tool("browser.navigate").execute(input({ url: "http://127.0.0.1:8931/" }));
  const snapshot = String((nav.result as any).snapshot);
  console.log("== SNAPSHOT ==\n" + snapshot);

  const buttonRef = snapshot.match(/button[^\n]*\[ref=([^\]]+)\]/)?.[1];
  const inputRef = snapshot.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
  if (!buttonRef) throw new Error("no button ref in snapshot");

  const click = await tool("browser.click").execute(input({ ref: buttonRef }));
  const afterClick = String((click.result as any).snapshot);
  console.log("== CLICK ref", buttonRef, "==\n" + afterClick);
  if (!afterClick.includes("clicked")) throw new Error("click did not take effect");

  if (!inputRef) throw new Error("no textbox ref in snapshot");
  await tool("browser.type").execute(input({ ref: inputRef, text: "synax" }));

  const evaluate = await tool("browser.evaluate").execute(input({ expression: "document.getElementById('out').textContent" }));
  console.log("== EVALUATE ==", (evaluate.result as any).value);
  if (!(evaluate.result as any).value.includes("clicked")) throw new Error("evaluate mismatch");

  const errors = await tool("browser.console").execute(input({ kind: "error" }));
  const errorLevels = (errors.result as any).entries.map((entry: any) => entry.level);
  console.log("== CONSOLE ==", JSON.stringify(errorLevels));
  if (!errorLevels.includes("pageerror") && !errorLevels.includes("error"))
    throw new Error("console capture missed the error");

  const network = await tool("browser.network").execute(input({ filter: "/api/" }));
  const entries = (network.result as any).entries;
  console.log("== NETWORK ==", JSON.stringify(entries.map((entry: any) => ({ url: entry.url, status: entry.status }))));
  if (!entries.length) throw new Error("network capture missed /api/ping");
  const withBody = await tool("browser.network").execute(input({ seq: entries[0].seq }));
  console.log("== NETWORK BODY ==", (withBody.result as any).body.text);

  await tool("browser.close").execute(input({}));
  console.log("SMOKE OK");
} finally {
  await closeAllBrowserSessions("smoke end");
  server.close();
}
