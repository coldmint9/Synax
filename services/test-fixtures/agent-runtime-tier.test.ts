import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyAgentRuntimeTests, projectRoot } from "./agent-runtime-tier.js";

/** Contract for the tier split: a suite that boots the supervisor must never
 * land in the unit tier, or the fast run starts a real sidecar per file. */
describe("agent-runtime test tiers", () => {
  const tiers = classifyAgentRuntimeTests();

  it("assigns every test file to exactly one tier", () => {
    const all = [...tiers.runtime, ...tiers.unit];
    expect(new Set(all).size).toBe(all.length);
    for (const file of all) expect(path.isAbsolute(file)).toBe(false);
    for (const file of all) expect(existsSync(path.join(projectRoot, file))).toBe(true);
  });

  it("keeps supervisor-booting suites in the runtime tier", () => {
    expect(tiers.runtime).toContain(
      "services/local-node/modules/agent-runtime/__tests__/rust-native-backend.test.ts",
    );
    expect(tiers.runtime).toContain(
      "services/local-node/modules/agent-runtime/__tests__/file-input.integration.test.ts",
    );
  });

  it("keeps pure unit suites out of the runtime tier", () => {
    expect(tiers.unit).toContain(
      "services/local-node/modules/agent-runtime/__tests__/read-tracker.test.ts",
    );
  });

  it("covers the whole module instead of a hand-maintained list", () => {
    expect(tiers.runtime.length).toBeGreaterThan(0);
    expect(tiers.unit.length).toBeGreaterThan(0);
    expect(tiers.runtime.length + tiers.unit.length).toBeGreaterThan(200);
  });
});
