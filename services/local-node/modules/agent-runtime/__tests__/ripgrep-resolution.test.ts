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
  const bin = path.join(dir, process.platform === "win32" ? "rg.cmd" : "rg");
  fs.writeFileSync(
    bin,
    process.platform === "win32"
      ? "@echo ripgrep 15.0.0-stub\r\n"
      : '#!/bin/sh\necho "ripgrep 15.0.0-stub"\n',
  );
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

describe("ripgrep resolution", () => {
  it.skipIf(process.platform === "win32")(
    "prefers the explicit SYNAX_RG_PATH override",
    async () => {
      const override = writeRgStub(path.join(tempHome(), "bin"));
      const resolved = await resolveRipgrepBinary({
        env: { SYNAX_RG_PATH: override },
        packagedPath: path.join(tempHome(), "missing-rg"),
      });
      expect(resolved).toBe(override);
    },
  );

  it("uses the packaged binary even when PATH is empty", async () => {
    const resolved = await resolveRipgrepBinary({ env: { PATH: "" } });
    expect(resolved).toContain("@vscode/ripgrep-universal");
  });

  it.skipIf(process.platform === "win32")(
    "does not resolve a host rg from PATH",
    async () => {
      const hostRg = writeRgStub(path.join(tempHome(), "host"));
      const previousPath = process.env.PATH;
      process.env.PATH = path.dirname(hostRg);
      try {
        const resolved = await resolveRipgrepBinary({
          env: { PATH: path.dirname(hostRg) },
          packagedPath: path.join(tempHome(), "missing-rg"),
        });
        expect(resolved).toBeNull();
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  it("caches the process-wide resolution until reset", async () => {
    const first = resolveRipgrep();
    const second = resolveRipgrep();
    expect(second).toBe(first);
    await first;
    resetRipgrepResolutionForTests();
    expect(resolveRipgrep()).not.toBe(first);
  });
});
