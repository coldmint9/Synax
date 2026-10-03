import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateCuaArtifact } from "./validate-cua-artifact.js";

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "synax-cua-artifact-"));
  const writePackage = (name: string, version: string, main = "index.js") => {
    const dir = path.join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, main }));
    writeFileSync(path.join(dir, main), "native");
  };
  writeFileSync(path.join(root, "cua-helper.cjs"), "helper");
  writePackage("@trycua/cua-driver", "0.30.2");
  writePackage("@ubjs/core", "0.31.0-3");
  writePackage("@ubjs/node", "0.31.0-3");
  writePackage("@ubjs/node-darwin-arm64", "0.31.0-3", "runtime.node");
  return root;
}

describe("validateCuaArtifact", () => {
  it("accepts a complete macOS arm64 helper artifact", () => {
    const root = fixture();
    try {
      expect(() => validateCuaArtifact({ helperRoot: root, platform: "darwin", arch: "arm64", requireDriver: false })).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports the exact missing runtime dependency", () => {
    const root = fixture();
    try {
      rmSync(path.join(root, "node_modules/@ubjs/core"), { recursive: true, force: true });
      expect(() => validateCuaArtifact({ helperRoot: root, platform: "darwin", arch: "arm64", requireDriver: false })).toThrow(/@ubjs\/core/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
