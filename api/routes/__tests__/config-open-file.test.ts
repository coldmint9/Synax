import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({
  error: null as Error | null,
  exec: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: vi.fn(() => {
    throw new Error("No editor CLI");
  }),
  execFile: opener.exec,
}));

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-open-config-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "config-open-test");
  vi.resetModules();
  opener.error = null;
  opener.exec
    .mockReset()
    .mockImplementation((_bin, _args, callback) => callback(opener.error));
});
afterEach(async () => {
  const { closeDb } = await import("../../db/index.js");
  closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("opening the global config", () => {
  const request = async (body: unknown) => {
    const { configRoutes } = await import("../config.js");
    return configRoutes.request("http://localhost/open-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  it("creates and opens the real global file without requiring a client path", async () => {
    const response = await request({ target: "global" });
    expect(response.status).toBe(200);
    const expected = path.join(root, "config", "global-config.json");
    expect(fs.existsSync(expected)).toBe(true);
    expect(opener.exec.mock.calls[0][1]).toContain(expected);
  });

  it("reports editor launch failure", async () => {
    opener.error = new Error("Editor could not start");
    const response = await request({ target: "global" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Editor could not start" });
  });

  it("keeps rejecting empty generic file requests", async () => {
    const response = await request({});
    expect(response.status).toBe(400);
    expect(opener.exec).not.toHaveBeenCalled();
  });
});
