import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("ships installed platform-native optional dependencies", () => {
    // @napi-rs/canvas resolves its prebuilt binding through optionalDependencies.
    // Copying only `dependencies` left image decoding broken in packaged builds.
    expect(script).toContain("optionalDependencies");
    const manifest = JSON.parse(
      readFileSync(
        new URL("../node_modules/@napi-rs/canvas/package.json", import.meta.url),
        "utf8",
      ),
    ) as { optionalDependencies?: Record<string, string> };
    const installed = Object.keys(manifest.optionalDependencies ?? {}).filter(
      (name) =>
        existsSync(
          join(
            new URL("../node_modules", import.meta.url).pathname,
            name,
            "package.json",
          ),
        ),
    );
    // The current platform binding must be installed for packaging to work.
    expect(installed.length).toBeGreaterThan(0);
  });
});
