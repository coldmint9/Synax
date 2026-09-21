import { describe, expect, it, vi } from "vitest";
import { ensureDmgNative } from "./prepare-dmg-native.js";

describe("macOS DMG native dependency preflight", () => {
  it("does nothing on other platforms", () => {
    const loadModule = vi.fn();
    const rebuild = vi.fn();
    ensureDmgNative({ platform: "win32", loadModule, rebuild });
    expect(loadModule).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("does not rebuild working native dependencies", () => {
    const rebuild = vi.fn();
    ensureDmgNative({ platform: "darwin", loadModule: vi.fn(), rebuild });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds each missing native module and verifies it loads", () => {
    const loaded = new Set<string>();
    const loadModule = vi.fn((name: string) => {
      if (!loaded.has(name)) throw new Error(`missing ${name}`);
    });
    const rebuild = vi.fn((name: string) => loaded.add(name));
    ensureDmgNative({ platform: "darwin", loadModule, rebuild });
    expect(rebuild).toHaveBeenCalledWith("macos-alias");
    expect(rebuild).toHaveBeenCalledWith("fs-xattr");
    expect(loadModule).toHaveBeenCalledTimes(4);
  });

  it("fails before Forge starts when a rebuild fails", () => {
    const loadModule = vi.fn(() => {
      throw new Error("missing native module");
    });
    const rebuild = vi.fn(() => {
      throw new Error("node-gyp failed");
    });
    expect(() =>
      ensureDmgNative({ platform: "darwin", loadModule, rebuild }),
    ).toThrow(/npm rebuild macos-alias/);
  });

  it("fails if a module still cannot be loaded after rebuilding", () => {
    const loadModule = vi.fn(() => {
      throw new Error("missing native module");
    });
    expect(() =>
      ensureDmgNative({ platform: "darwin", loadModule, rebuild: vi.fn() }),
    ).toThrow(/macos-alias.*after rebuilding/);
  });
});
