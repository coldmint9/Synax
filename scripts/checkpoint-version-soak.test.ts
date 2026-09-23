import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("runs bounded mixed operations with retained checkpoints, readers and a fork", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synax-soak-test-"));
  try {
    const output = path.join(directory, "result.json");
    execFileSync(process.execPath, ["--import", "tsx", path.resolve("scripts/checkpoint-version-soak.ts"), "--operations", "100", "--output", output], { encoding: "utf8", timeout: 30000 });
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.scope).toBe("version-core-soak-only");
    expect(report.endToEndAccepted).toBe(false);
    expect(report.operations).toBe(100);
    expect(report.rollbacks).toBe(20);
    expect(report.maintenance.removed).toBeGreaterThan(0);
    expect(report.maintenance.remaining).toBe(false);
    expect(report.final.objects.bytes).toBeLessThan(256 * 1024);
    expect(report.retainedCheckpointsVerified).toBe(3);
    expect(report.forkVerified).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
