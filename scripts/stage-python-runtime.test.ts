import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pythonArchives, validatePythonArchiveLayout, verifyPythonArchive } from "./stage-python-runtime.js";

describe("Python distribution staging", () => {
  it("pins every supported platform/architecture to a SHA-256", () => {
    expect(Object.keys(pythonArchives).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    for (const archive of Object.values(pythonArchives)) expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects modified downloads before extraction", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-python-checksum-"));
    try {
      const file = path.join(dir, "archive"); fs.writeFileSync(file, "verified fixture");
      const digest = createHash("sha256").update("verified fixture").digest("hex");
      await expect(verifyPythonArchive(file, digest)).resolves.toBeUndefined();
      fs.appendFileSync(file, "tampered");
      await expect(verifyPythonArchive(file, digest)).rejects.toThrow(/SHA-256 mismatch/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("accepts install_only layouts and rejects absolute/traversing members", () => {
    expect(() => validatePythonArchiveLayout("python/\npython/bin/python3\npython/lib/libpython.dylib\n")).not.toThrow();
    for (const list of ["", "/python/bin/python3", "python/../escape", "other/file", "python/..\\escape"])
      expect(() => validatePythonArchiveLayout(list)).toThrow(/layout/);
  });
});
