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

  it("rejects executable paths supplied as opener ids", async () => {
    const response = await request({ target: "global", opener: "/tmp/arbitrary-app" });
    expect(response.status).toBe(400);
    expect(opener.exec).not.toHaveBeenCalled();
  });

  it("rejects invalid line numbers", async () => {
    const response = await request({ target: "global", line: -1 });
    expect(response.status).toBe(400);
    expect(opener.exec).not.toHaveBeenCalled();
  });

  it("resolves and launches the selected app with the requested line", async () => {
    const discovery = await import("../../services/file-openers/index.js");
    const resolve = vi.spyOn(discovery, "resolveFileOpener").mockResolvedValue({ command: { bin: "/apps/zed", args: ["/file:12"] }, fallback: false });
    const response = await request({ target: "global", opener: "zed", line: 12 });
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith(expect.any(String), 12, "zed");
    expect(opener.exec.mock.calls[0].slice(0, 2)).toEqual(["/apps/zed", ["/file:12"]]);
  });

  it("reports fallback when the saved app is unavailable", async () => {
    const discovery = await import("../../services/file-openers/index.js");
    vi.spyOn(discovery, "resolveFileOpener").mockResolvedValue({ command: { bin: "/usr/bin/open", args: ["/file"] }, fallback: true });
    expect(await (await request({ target: "global", opener: "zed" })).json()).toEqual({ ok: true, fallback: true });
  });

  it("falls back to the OS association when a selected app cannot launch", async () => {
    const discovery = await import("../../services/file-openers/index.js");
    const resolve = vi.spyOn(discovery, "resolveFileOpener")
      .mockResolvedValueOnce({ command: { bin: "/apps/zed", args: ["/file"] }, fallback: false })
      .mockResolvedValueOnce({ command: { bin: "/usr/bin/open", args: ["/file"] }, fallback: false });
    opener.exec.mockImplementationOnce((_bin, _args, callback) => callback(new Error("App removed")));
    expect(await (await request({ target: "global", opener: "zed" })).json()).toEqual({ ok: true, fallback: true });
    expect(resolve.mock.calls[1][2]).toBe("system");
  });

  it("keeps rejecting empty generic file requests", async () => {
    const response = await request({});
    expect(response.status).toBe(400);
    expect(opener.exec).not.toHaveBeenCalled();
  });
});
