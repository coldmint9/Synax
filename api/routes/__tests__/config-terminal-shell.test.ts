import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-shell-config-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "terminal-config-test");
  vi.resetModules();
});
afterEach(async () => {
  const { terminalManager } =
    await import("../../services/terminals/terminal-manager.js");
  await terminalManager.shutdown();
  const { closeDb } = await import("../../db/index.js");
  closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
async function update(terminalShellPath: unknown) {
  const { configRoutes } = await import("../config.js");
  return configRoutes.request("http://localhost/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terminalShellPath }),
  });
}

it("reports the system shell and persists and resets a custom path", async () => {
  const { configRoutes } = await import("../config.js");
  const { systemTerminalShell } =
    await import("../../services/terminals/terminal-shell.js");
  expect(
    await (
      await configRoutes.request("http://localhost/terminal-shell")
    ).json(),
  ).toEqual({ defaultPath: systemTerminalShell() });
  const response = await update(` ${process.execPath} `);
  expect(response.status).toBe(200);
  expect((await response.json()).config.terminalShellPath).toBe(
    process.execPath,
  );
  const stored = JSON.parse(
    fs.readFileSync(path.join(root, "config/global-config.json"), "utf8"),
  );
  expect(stored.terminalShellPath).toBe(process.execPath);
  expect(
    (await (await configRoutes.request("http://localhost/global")).json())
      .config.terminalShellPath,
  ).toBe(process.execPath);
  const reset = await update("");
  expect(reset.status).toBe(200);
  expect((await reset.json()).config.terminalShellPath).toBe("");
});

it("rejects relative, missing and non-executable paths without changing the saved shell", async () => {
  expect((await update(process.execPath)).status).toBe(200);
  const nonExecutable = path.join(root, "plain-file");
  fs.writeFileSync(nonExecutable, "text", { mode: 0o600 });
  const invalid: unknown[] = [
    "relative/shell",
    path.join(root, "missing"),
    root,
    123,
    "/bin/sh\n-c",
  ];
  if (process.platform !== "win32") invalid.push(nonExecutable);
  for (const value of invalid)
    expect((await update(value)).status, String(value)).toBe(400);
  const { getGlobalConfig } = await import("../../lib/config/config-store.js");
  expect(getGlobalConfig().terminalShellPath).toBe(process.execPath);
});

it.skipIf(process.platform === "win32")(
  "launches new PTYs with the saved shell path, including spaces",
  async () => {
    const shell = path.join(root, "custom shell");
    fs.writeFileSync(
      shell,
      '#!/bin/sh\nprintf "CUSTOM_SHELL_STARTED\\n"\nexec /bin/sh -i\n',
      { mode: 0o755 },
    );
    expect((await update(shell)).status).toBe(200);
    const { terminalManager } =
      await import("../../services/terminals/terminal-manager.js");
    const item = await terminalManager.create({
      projectId: "shell-test",
      rootId: "primary",
      kind: "terminal",
      title: "Custom shell",
      cwd: root,
      env: { HOME: root },
    });
    expect(item.shell).toBe(shell);
    await vi.waitFor(() =>
      expect(terminalManager.snapshot(item.id).data).toContain(
        "CUSTOM_SHELL_STARTED",
      ),
    );
    await update("");
    expect(terminalManager.get(item.id).shell).toBe(shell);
    expect(terminalManager.get(item.id).state).toBe("active");
  },
);
