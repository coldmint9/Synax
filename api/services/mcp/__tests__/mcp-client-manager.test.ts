import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
};

let tempDir = "";
let manager: typeof import("../mcp-client-manager.js").mcpClientManager;
let updateGlobalConfig: (patch: Record<string, unknown>, by: string) => void;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "Synax-mcp-test-"));
  process.env.DATA_ROOT = tempDir;
  process.env.CONFIG_ENCRYPTION_KEY = "unit-test-mcp-secret";
  vi.resetModules();
  const configModule = await import("../../../lib/config/config-store.js");
  updateGlobalConfig = configModule.updateGlobalConfig as (
    patch: Record<string, unknown>,
    by: string,
  ) => void;
  const managerModule = await import("../mcp-client-manager.js");
  manager = managerModule.mcpClientManager;
});

afterEach(async () => {
  try {
    manager.closeAll();
  } catch {
    /* noop */
  }
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  process.env.DATA_ROOT = originalEnv.DATA_ROOT;
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY;
});

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-mcp-server.mjs", import.meta.url),
);

describe("mcp client manager", () => {
  it("probes a stdio server and lists its tools", async () => {
    const result = await manager.probe({
      id: "fixture",
      name: "Fixture",
      command: process.execPath,
      args: [fixturePath],
    });
    expect(result.ok).toBe(true);
    expect(result.tools.map((t) => t.name)).toContain("echo");
  }, 15000);

  it("warmup + callTool against a configured server", async () => {
    updateGlobalConfig(
      {
        mcpServers: [
          {
            id: "fixture",
            name: "Fixture",
            command: process.execPath,
            args: [fixturePath],
            env: { MCP_FIXTURE: "1" },
          },
        ],
      },
      "tester",
    );

    await manager.warmup(["fixture"]);
    expect(manager.getCachedTools("fixture").map((t) => t.name)).toContain(
      "echo",
    );

    const call = await manager.callTool("fixture", "echo", {
      text: "hello mcp",
    });
    expect(call.ok).toBe(true);
    expect(call.text).toContain("hello mcp");
  }, 20000);

  it("returns a failure when the server command does not exist", async () => {
    const result = await manager.probe({
      id: "missing",
      name: "Missing",
      command: "/definitely/not/a/real/bin/xyz",
      args: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  }, 15000);
});

it("returns actionable errors for invalid cwd and relative executables", async () => {
  const invalidCwd = await manager.probe({
    id: "bad-cwd",
    name: "Bad cwd",
    command: process.execPath,
    cwd: path.join(tempDir, "missing"),
  });
  expect(invalidCwd).toMatchObject({
    ok: false,
    error: expect.stringContaining("MCP working directory"),
  });
  const invalidCommand = await manager.probe({
    id: "relative",
    name: "Relative",
    command: "./Plugin.app/server",
    cwd: tempDir,
  });
  expect(invalidCommand).toMatchObject({
    ok: false,
    error: expect.stringContaining("MCP executable"),
  });
});

it("keeps identically named project MCP servers in their own working directories", async () => {
  const { updateProjectSettings } =
    await import("../../../lib/config/project-settings-store.js");
  const roots = ["one", "two"].map((id) => ({
    id,
    source: { localPath: path.join(tempDir, id) },
  }));
  fs.writeFileSync(
    path.join(tempDir, "projects.json"),
    JSON.stringify({ items: roots }),
  );
  for (const project of roots) {
    fs.mkdirSync(project.source.localPath);
    updateProjectSettings(
      project.id,
      {
        mcpServers: [
          {
            id: "shared",
            name: "Shared",
            command: process.execPath,
            args: [fixturePath],
          },
        ],
      },
      "tester",
    );
    await manager.warmup(["shared"], project.id);
    expect(
      manager.getCachedTools("shared", project.id).map((t) => t.name),
    ).toContain("echo");
  }
  for (const project of roots) {
    const result = await manager.callTool(
      "shared",
      "echo",
      { inspectCwd: true },
      project.id,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.text).cwd).toBe(
      fs.realpathSync(project.source.localPath),
    );
  }
  expect(manager.getCachedTools("shared")).toEqual([]);
}, 20000);
