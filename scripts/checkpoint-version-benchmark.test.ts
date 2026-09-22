import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const entry = path.resolve("scripts/checkpoint-version-benchmark.ts");
describe("isolated checkpoint core benchmark", () => {
  it("reports real disk-backed root switches without claiming end-to-end acceptance", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-benchmark-test-"));
    try {
      const output = path.join(directory, "report.json");
      execFileSync(process.execPath, ["--import", "tsx", entry, "--entries", "1000", "--switches", "20", "--output", output], { encoding: "utf8", timeout: 30_000 });
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report.scope).toBe("version-core-only");
      expect(report.endToEndAccepted).toBe(false);
      expect(report.sqlite.synchronous).toBe("FULL");
      expect(report.cases).toHaveLength(1);
      expect(report.cases[0].entries).toBe(1000);
      expect(report.cases[0].switches.samples).toHaveLength(20);
      expect(report.cases[0].objectBytesAfterSwitches).toBe(report.cases[0].objectBytesBeforeSwitches);
      expect(report.cases[0].objectCountAfterSwitches).toBe(report.cases[0].objectCountBeforeSwitches);
      expect(report.cases[0].files.database).toBeGreaterThan(0);
      expect(report.cases[0].storage.objectsByKind.find((row: { kind: string }) => row.kind === "chunk").count).toBe(1000);
      expect(report.cases[0].memory.peakRss).toBeGreaterThan(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("collects abandoned versions while retaining explicit checkpoint roots", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-benchmark-gc-test-"));
    try {
      const output = path.join(directory, "report.json");
      execFileSync(process.execPath, ["--import", "tsx", entry, "--entries", "1000", "--switches", "20", "--collect", "1", "--checkpoints", "2", "--output", output], { encoding: "utf8", timeout: 30_000 });
      const result = JSON.parse(readFileSync(output, "utf8")).cases[0];
      expect(result.retainedCheckpointPins).toBe(2);
      expect(result.maintenance.calls).toBeGreaterThan(0);
      expect(result.maintenance.removed).toBeGreaterThan(0);
      expect(result.maintenance.remaining).toBe(false);
      expect(result.metadata.bytes).toBeGreaterThan(0);
      expect(result.disk.sqliteAllocatedBytes).toBeGreaterThanOrEqual(result.disk.freePageBytes);
      expect(result.objectCountAfterSwitches).toBe(result.objectCountBeforeSwitches);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects unbounded/invalid benchmark workloads before opening a database", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", entry, "--entries", "999999999999999"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/entries/i);
  });
});
