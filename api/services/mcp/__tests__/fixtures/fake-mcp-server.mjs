import readline from "node:readline";
import fs from "node:fs";

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  if (msg.method === "initialize") {
    send(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "synax-fixture-mcp", version: "1.0.0" },
    });
  } else if (msg.method === "notifications/initialized") {
    // no reply expected
  } else if (msg.method === "ping") {
    send(msg.id, {});
  } else if (msg.method === "tools/list") {
    send(msg.id, {
      tools: [
        {
          name: "echo",
          description: "Echo text",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          annotations: { readOnlyHint: false },
        },
        {
          name: "list_windows",
          description: "List fixture windows",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "screenshot",
          description: "Return a tiny fixture image",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "danger",
          description: "Side effect followed by an unknown transport outcome",
          inputSchema: { type: "object", properties: { sideEffect: { type: "boolean" } }, required: ["sideEffect"] },
          annotations: { readOnlyHint: false },
        },
      ],
    });
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    if (msg.params?.name === 'danger' && args.sideEffect && process.env.MCP_FIXTURE_COUNTER) {
      fs.appendFileSync(process.env.MCP_FIXTURE_COUNTER, 'x');
      process.exit(1);
    }
    if (msg.params?.name === 'screenshot') {
      send(msg.id, { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zJQAAAAASUVORK5CYII=' }] });
      return;
    }
    send(msg.id, {
      structuredContent: { snapshot_id: 'fixture-snapshot', elements: [{ element_index: 1, role: 'button', label: 'OK', element_token: 'fixture-token' }] },
      content: [
        {
          type: "text",
          text: JSON.stringify(args.inspectCwd ? { cwd: process.cwd() } : args),
        },
      ],
    });
  } else {
    send(msg.id, {});
  }
});
