import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./copy-native-modules.ts", import.meta.url), "utf8");

describe("native module packaging manifest", () => {
  it("does not copy retired parser or native build-only packages", () => {
    expect(script).not.toContain('"tree-sitter"');
    expect(script).not.toContain('startsWith("tree-sitter-")');
    expect(script).not.toContain('"node-gyp-build"');
    expect(script).not.toContain('"node-addon-api"');
  });

  it("keeps the runtime packages that are still externalized by the server bundle", () => {
    expect(script).toContain('"@anthropic-ai/claude-agent-sdk"');
    expect(script).toContain('"playwright-core"');
    expect(script).toContain('"node-pty"');
  });
});
