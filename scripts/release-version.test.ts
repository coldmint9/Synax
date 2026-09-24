import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const json = (file: string) => JSON.parse(read(file));
const version = read(".env.version").trim().replace("SYNAX_VERSION=", "");

describe("software version consistency", () => {
  it("aligns application manifests and workspace lockfiles", () => {
    expect(json("web/package.json").version).toBe(version);
    for (const file of ["package-lock.json", "web/package-lock.json"]) {
      const lock = json(file);
      expect(lock.version).toBe(version);
      expect(lock.packages[""].version).toBe(version);
    }
    expect(json("package-lock.json").packages.web.version).toBe(version);
  });
  it("aligns CLI, About and provider client identities", () => {
    expect(read("cli/main.ts")).toContain(`CLI_VERSION = "${version}"`);
    expect(read("web/src/react/pages/AboutPage.tsx")).toContain(`VERSION = "${version}"`);
    for (const file of ["api/services/mcp/mcp-client-manager.ts", "api/services/agent-runtime/backends/codex-connection.ts"]) {
      expect(read(file).match(/version: "\d+\.\d+\.\d+"/g)?.every(value => value === `version: "${version}"`)).toBe(true);
    }
    expect(read("api/services/agent-runtime/backends/claude-connection.ts")).toContain(`CLAUDE_AGENT_SDK_CLIENT_APP = "synax/${version}"`);
  });
});
