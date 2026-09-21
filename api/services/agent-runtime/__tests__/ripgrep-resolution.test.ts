import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetRipgrepResolutionForTests,
  resolveRipgrep,
  resolveRipgrepBinary,
} from "../tools/ripgrep.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  resetRipgrepResolutionForTests();
  delete process.env.SYNAX_RG_PATH;
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-rg-home-"));
  dirs.push(dir);
  return dir;
}

function writeRgStub(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "rg");
  fs.writeFileSync(bin, '#!/bin/sh\necho "ripgrep 15.0.0-stub"\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe.skipIf(process.platform === "win32")("ripgrep resolution", () => {
  it("prefers the SYNAX_RG_PATH override even with a minimal PATH", async () => {
    const home = tempHome();
    const override = writeRgStub(path.join(home, "bin"));
    const resolved = await resolveRipgrepBinary({
      env: { PATH: "", SYNAX_RG_PATH: override },
      homeDir: home,
    });
    expect(resolved).toBe(override);
  });

  it("resolves rg through PATH when it is installed there", async () => {
    const home = tempHome();
    const stubDir = path.join(home, "on-path");
    writeRgStub(stubDir);
    const previousPath = process.env.PATH;
    process.env.PATH = stubDir;
    try {
      const resolved = await resolveRipgrepBinary({
        env: { PATH: stubDir },
        homeDir: tempHome(),
      });
      expect(resolved).toBe("rg");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("falls back to ~/.cargo/bin/rg when PATH has no rg", async () => {
    const home = tempHome();
    const cargoRg = writeRgStub(path.join(home, ".cargo", "bin"));
    // The `rg` PATH probe inherits the test process env, so clear it too.
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const resolved = await resolveRipgrepBinary({
        env: { PATH: "" },
        homeDir: home,
      });
      expect(resolved).toBe(cargoRg);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("skips an invalid SYNAX_RG_PATH instead of failing", async () => {
    const home = tempHome();
    const resolved = await resolveRipgrepBinary({
      env: { PATH: "", SYNAX_RG_PATH: path.join(home, "missing", "rg") },
      homeDir: home,
    });
    expect(resolved).not.toBe(path.join(home, "missing", "rg"));
  });

  it("caches the process-wide resolution until reset", async () => {
    const first = resolveRipgrep();
    const second = resolveRipgrep();
    expect(second).toBe(first);
    await first;
    resetRipgrepResolutionForTests();
    expect(resolveRipgrep()).not.toBe(first);
  });
});
