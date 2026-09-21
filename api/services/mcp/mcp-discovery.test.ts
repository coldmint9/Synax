import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLocalMcpServers } from "./mcp-discovery.js";

const cleanup: string[] = [];

function fixture(): { home: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-mcp-discovery-"));
  cleanup.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { home, project };
}

function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

afterEach(() => {
  for (const directory of cleanup.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("discoverLocalMcpServers", () => {
  it("discovers JSONC, OpenCode, and Codex stdio servers and deduplicates them", () => {
    const { home, project } = fixture();
    write(
      path.join(project, ".cursor", "mcp.json"),
      `{
      // JSONC comments and trailing commas are supported.
      "mcpServers": {
        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], },
        "remote-only": { "type": "http", "url": "https://example.test/mcp" }
      }
    }`,
    );
    write(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "same-command": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
        },
      }),
    );
    write(
      path.join(home, ".config", "opencode", "opencode.jsonc"),
      `{
      "mcp": { "browser": { "type": "local", "command": ["npx", "-y", "browser-mcp"], "environment": { "PORT": 3333 } } }
    }`,
    );
    write(
      path.join(home, ".codex", "config.toml"),
      `
      [mcp_servers.github]
      command = "docker"
      args = ["run", "--rm", "github-mcp"]
      env = { TOKEN = "secret" }

      [mcp_servers.remote]
      url = "https://example.test/mcp"
    `,
    );

    const result = discoverLocalMcpServers(project, {
      homeDir: home,
      platform: "linux",
      env: {},
    });

    expect(result.scannedFiles).toBe(4);
    expect(result.warnings).toEqual([]);
    expect(result.servers).toHaveLength(3);
    expect(result.servers.map((item) => item.server.name)).toEqual([
      "browser",
      "filesystem",
      "github",
    ]);
    expect(
      result.servers.find((item) => item.server.name === "filesystem")?.sources,
    ).toEqual([
      { client: "Cursor", path: "./.cursor/mcp.json", scope: "project" },
      { client: "Cursor", path: "~/.cursor/mcp.json", scope: "user" },
    ]);
    expect(
      result.servers.find((item) => item.server.name === "browser")?.server,
    ).toMatchObject({
      command: "npx",
      args: ["-y", "browser-mcp"],
      env: { PORT: "3333" },
      cwd: project,
      enabled: true,
    });
    expect(
      result.servers.find((item) => item.server.name === "github")?.server.env,
    ).toEqual({ TOKEN: "secret" });
  });

  it("reads only the active project section from Claude Code user settings", () => {
    const { home, project } = fixture();
    write(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { global: { command: "global-server" } },
        projects: {
          [project]: { mcpServers: { local: { command: "local-server" } } },
          [path.join(home, "other-project")]: {
            mcpServers: { unrelated: { command: "other-server" } },
          },
        },
      }),
    );

    const result = discoverLocalMcpServers(project, {
      homeDir: home,
      platform: "linux",
      env: {},
    });

    expect(result.servers.map((item) => item.server.name)).toEqual([
      "global",
      "local",
    ]);
    expect(
      result.servers.find((item) => item.server.name === "global")?.sources[0]
        .scope,
    ).toBe("user");
    expect(
      result.servers.find((item) => item.server.name === "local")?.sources[0]
        .scope,
    ).toBe("project");
  });

  it("discovers project Codex and Gemini configs and preserves execution context", () => {
    const { home, project } = fixture();
    write(
      path.join(project, ".codex", "config.toml"),
      `
      [mcp_servers.codex-local]
      command = "node"
      args = ["\${workspaceFolder}/server.mjs", "\${env:MCP_TOKEN}"]
      cwd = "tools"
    `,
    );
    write(
      path.join(project, ".gemini", "settings.json"),
      JSON.stringify({
        mcpServers: {
          "gemini-local": {
            command: "node",
            args: ["${userHome}/gemini-server.mjs"],
            cwd: "${workspaceFolder}",
            env: { TOKEN: "${env:MCP_TOKEN}" },
          },
        },
      }),
    );

    const result = discoverLocalMcpServers(project, {
      homeDir: home,
      platform: "linux",
      env: {},
    });

    expect(result.scannedFiles).toBe(2);
    expect(result.servers.map((item) => item.server.name)).toEqual([
      "codex-local",
      "gemini-local",
    ]);
    expect(
      result.servers.find((item) => item.server.name === "codex-local")?.server,
    ).toMatchObject({
      args: ["${workspaceFolder}/server.mjs", "${env:MCP_TOKEN}"],
      cwd: path.join(project, "tools"),
    });
    expect(
      result.servers.find((item) => item.server.name === "gemini-local")
        ?.server,
    ).toMatchObject({
      args: ["${userHome}/gemini-server.mjs"],
      cwd: project,
      env: { TOKEN: "${env:MCP_TOKEN}" },
    });
  });

  it("reports unreadable configs without failing the remaining discovery", () => {
    const { home, project } = fixture();
    write(path.join(project, ".mcp.json"), "{ invalid json");
    write(
      path.join(home, ".gemini", "settings.json"),
      JSON.stringify({
        mcpServers: { valid: { command: "valid-server" } },
      }),
    );

    const result = discoverLocalMcpServers(project, {
      homeDir: home,
      platform: "linux",
      env: {},
    });

    expect(result.servers.map((item) => item.server.name)).toEqual(["valid"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      client: "Claude Code",
      path: "./.mcp.json",
    });
  });
});

it("does not import a plugin-relative executable against an unrelated project cwd", () => {
  const { home, project } = fixture();
  write(
    path.join(home, ".codex", "config.toml"),
    `
    [mcp_servers.plugin]
    command = "./Plugin.app/Contents/MacOS/server"
    [mcp_servers.valid]
    command = "node"
  `,
  );
  const result = discoverLocalMcpServers(project, {
    homeDir: home,
    platform: "linux",
    env: {},
  });
  expect(result.servers.map((item) => item.server.name)).toEqual(["valid"]);
  expect(result.unsupported).toContainEqual(
    expect.objectContaining({
      name: "plugin",
      reason: expect.stringMatching(/relative MCP executable/i),
    }),
  );
});

it("makes a verified relative executable absolute using its configured cwd", () => {
  const { home, project } = fixture();
  const tools = path.join(project, "tools");
  write(path.join(tools, "server"), "#!/bin/sh\nexit 0\n");
  write(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: "./server", cwd: tools },
      },
    }),
  );
  const result = discoverLocalMcpServers(project, {
    homeDir: home,
    platform: "linux",
    env: {},
  });
  expect(result.servers[0].server).toMatchObject({
    command: path.join(tools, "server"),
    cwd: tools,
  });
});
