import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-effective-cu-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "effective-cu-test");
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../infrastructure/database/index.js")).closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("falls back to global Computer Use defaults for untouched projects", async () => {
  const { updateGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
  updateGlobalConfig(
    {
      computerUse: {
        enabled: true,
        strategy: "jev",
        perception: "auto",
        jev: { enabled: true, fallback: "fail_closed" },
      },
    },
    "test",
  );
  const { resolveEffectiveComputerUseSettings } =
    await import("./effective-settings.js");
  const effective = resolveEffectiveComputerUseSettings("proj-untouched");
  expect(effective.strategy).toBe("jev");
  expect(effective.perception).toBe("auto");
  expect(effective.jev?.enabled).toBe(true);
});

it("keeps explicit project overrides", async () => {
  const { updateGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
  const { updateProjectSettings } =
    await import("../../infrastructure/runtime/config/project-settings-store.js");
  updateGlobalConfig(
    {
      computerUse: {
        strategy: "jev",
        perception: "auto",
        jev: { enabled: true, fallback: "fail_closed" },
      },
    },
    "test",
  );
  updateProjectSettings(
    "proj-explicit",
    { computerUse: { strategy: "direct", perception: "required" } },
    "test",
  );
  const { resolveEffectiveComputerUseSettings } =
    await import("./effective-settings.js");
  const effective = resolveEffectiveComputerUseSettings("proj-explicit");
  // Values that differ from the project default count as explicit overrides.
  expect(effective.strategy).toBe("direct");
  expect(effective.perception).toBe("required");
});

it("merges global values into partially configured projects", async () => {
  const { updateGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
  const { updateProjectSettings } =
    await import("../../infrastructure/runtime/config/project-settings-store.js");
  updateGlobalConfig({ computerUse: { strategy: "auto", perception: "auto" } }, "test");
  updateProjectSettings(
    "proj-partial",
    { computerUse: { strategy: "jev", jev: { enabled: true, fallback: "fail_closed" } } },
    "test",
  );
  const { resolveEffectiveComputerUseSettings } =
    await import("./effective-settings.js");
  const effective = resolveEffectiveComputerUseSettings("proj-partial");
  expect(effective.strategy).toBe("jev");
  expect(effective.perception).toBe("auto");
});
