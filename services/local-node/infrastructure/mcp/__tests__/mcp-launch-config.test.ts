import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { mcpLaunchConfig } from "../mcp-launch-config.js";
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "synax-mcp-launch-")),
);
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const config = { id: "test", name: "Test", command: "node" };
it("uses home rather than the API process directory for global servers", () => {
  expect(mcpLaunchConfig(config).cwd).toBe(fs.realpathSync(os.homedir()));
});
it("resolves workspace variables and relative cwd from an explicit workspace", () => {
  fs.mkdirSync(path.join(directory, "tools"), { recursive: true });
  expect(
    mcpLaunchConfig(
      {
        ...config,
        cwd: "${workspaceFolder}/tools",
        args: ["${workspaceFolder}/main.js"],
      },
      directory,
    ),
  ).toMatchObject({
    cwd: path.join(directory, "tools"),
    args: [path.join(directory, "main.js")],
  });
  expect(mcpLaunchConfig({ ...config, cwd: "tools" }, directory).cwd).toBe(
    path.join(directory, "tools"),
  );
});
it("resolves relative executables only with an explicit base and checks the result", () => {
  const executable = path.join(directory, "test-server");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  expect(
    mcpLaunchConfig({ ...config, command: "./test-server", cwd: directory })
      .command,
  ).toBe(executable);
  expect(() =>
    mcpLaunchConfig({ ...config, command: "./missing", cwd: directory }),
  ).toThrow(/MCP executable.*missing.*cwd/);
  expect(() =>
    mcpLaunchConfig({ ...config, command: "./test-server" }),
  ).toThrow(/explicit.*cwd/);
});
it("rejects invalid working directories before spawning", () => {
  expect(() =>
    mcpLaunchConfig({ ...config, cwd: path.join(directory, "missing") }),
  ).toThrow(/MCP working directory/);
});
it("uses the selected cwd for legacy workspace variables when no project base was supplied", () => {
  expect(
    mcpLaunchConfig({
      ...config,
      cwd: directory,
      args: ["${workspaceFolder}/main.js"],
    }).args,
  ).toEqual([path.join(directory, "main.js")]);
});
