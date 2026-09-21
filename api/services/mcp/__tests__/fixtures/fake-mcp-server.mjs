import readline from "node:readline";

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
      ],
    });
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    send(msg.id, {
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
