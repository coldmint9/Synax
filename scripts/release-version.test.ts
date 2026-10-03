import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const json = (file: string) => JSON.parse(read(file));
const version = read(".env.version").trim().replace("SYNAX_VERSION=", "");

describe("software version consistency", () => {
  it("aligns application manifests and workspace lockfiles", () => {
    expect(json("client/package.json").version).toBe(version);
    for (const file of ["package-lock.json", "client/package-lock.json"]) {
      const lock = json(file);
      expect(lock.version).toBe(version);
      expect(lock.packages[""].version).toBe(version);
    }
    expect(json("package-lock.json").packages.client.version).toBe(version);
  });
  it("aligns CLI, About and provider client identities", () => {
    expect(read("cli/main.ts")).toContain(`CLI_VERSION = "${version}"`);
    expect(read("client/src/app/pages/AboutPage.tsx")).toContain(`VERSION = "${version}"`);
    for (const file of ["services/local-node/infrastructure/mcp/mcp-client-manager.ts", "services/local-node/modules/agent-runtime/backends/codex-connection.ts"]) {
      expect(read(file).match(/version: "\d+\.\d+\.\d+"/g)?.every(value => value === `version: "${version}"`)).toBe(true);
    }
    expect(read("services/local-node/modules/agent-runtime/backends/claude-connection.ts")).toContain(`CLAUDE_AGENT_SDK_CLIENT_APP = "synax/${version}"`);
  });
});
