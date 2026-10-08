import readline from "node:readline";
import fs from "node:fs";

if (process.env.MCP_FIXTURE_START_LOG) {
  fs.appendFileSync(process.env.MCP_FIXTURE_START_LOG, `${process.pid}\n`);
}

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

/** Desktop-scope parse result: affine source pixels -> action coordinates (x2). */
const desktopVisualFixture = {
  schema: "cua.visual_regions_v1",
  capture: {
    capture_id: "fixture-desktop-capture",
    source: { kind: "primary_desktop", display_id: "primary" },
    screenshot: { mime_type: "image/png", reference: "capture://desktop", width: 100, height: 80 },
    action_coordinate_space: { kind: "affine", m11: 2, m12: 0, m21: 0, m22: 2, tx: 0, ty: 0 },
  },
  regions: [
    {
      id: "region-desktop-1",
      kind: "text",
      text: "Continue",
      bounds: { x: 10, y: 20, width: 30, height: 20 },
      confidence: 0.9,
      interactive: true,
    },
  ],
};

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
        {
          name: "get_desktop_state",
          description: "Fixture primary-desktop capture",
          inputSchema: { type: "object", properties: { max_image_dimension: { type: "integer" } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: "parse_visual_regions",
          description: "Fixture capture-bound visual regions",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "click",
          description: "Fixture click",
          inputSchema: { type: "object", properties: { capture_id: { type: "string" } } },
          annotations: { readOnlyHint: false },
        },
      ],
    });
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    const name = msg.params?.name;
    if (name === "get_window_state" && process.env.MCP_FIXTURE_WINDOW_DEGRADED === "1") {
      send(msg.id, {
        structuredContent: { degraded: true, reason: "ax_window_unresolved" },
        content: [{ type: "text", text: "degraded" }],
      });
      return;
    }
    if (name === "get_desktop_state") {
      const available = process.env.MCP_FIXTURE_DESKTOP_UNAVAILABLE !== "1";
      send(msg.id, {
        structuredContent: available
          ? { capture_id: "fixture-desktop-capture", display: "primary", screenshot_width: 100, screenshot_height: 80, scale_factor: 2 }
          : { error: "capture_unavailable" },
        content: [{ type: "text", text: available ? "desktop" : "unavailable" }],
      });
      return;
    }
    if (name === "parse_visual_regions") {
      send(msg.id, {
        structuredContent: desktopVisualFixture,
        content: [{ type: "text", text: "regions" }],
      });
      return;
    }
    if (name === "click") {
      send(msg.id, {
        structuredContent: { clicked: args },
        content: [{ type: "text", text: JSON.stringify(args) }],
      });
      return;
    }
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
