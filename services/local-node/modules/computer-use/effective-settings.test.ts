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
  expect(effective.enabled).toBe(true);
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

it("defaults to disabled and requires global opt-in even for explicitly enabled projects", async () => {
  const { createDefaultGlobalConfig, createDefaultUserGlobalConfig } = await import("../../infrastructure/runtime/config/config-defaults.js");
  expect(createDefaultGlobalConfig().computerUse?.enabled).toBe(false);
  expect(createDefaultUserGlobalConfig().computerUse?.enabled).toBe(false);
  const { getGlobalConfig, updateGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
  const { updateProjectSettings, getProjectSettings } = await import("../../infrastructure/runtime/config/project-settings-store.js");
  const { resolveEffectiveComputerUseSettings } = await import("./effective-settings.js");
  expect(getGlobalConfig().computerUse?.enabled).toBe(false);
  updateProjectSettings("project-gate", { computerUse: { enabled: true } }, "test");
  expect(resolveEffectiveComputerUseSettings("project-gate").enabled).toBe(false);
  updateGlobalConfig({ computerUse: { enabled: true } }, "test");
  expect(resolveEffectiveComputerUseSettings("project-gate").enabled).toBe(true);
  updateProjectSettings("project-gate", { computerUse: { enabled: false } }, "test");
  expect(resolveEffectiveComputerUseSettings("project-gate").enabled).toBe(false);
  updateProjectSettings("project-gate", { computerUse: { enabled: true } }, "test");
  updateGlobalConfig({ computerUse: { enabled: false } }, "test");
  expect(resolveEffectiveComputerUseSettings("project-gate").enabled).toBe(false);
  expect(getProjectSettings("project-gate").computerUse.enabled).toBe(true);
});

it.each([undefined, {}, { enabled: false }, { enabled: true }])("normalizes stored global settings %j without overriding explicit opt-in", async (computerUse) => {
  const { getGlobalConfigFilePath, getGlobalConfig } = await import("../../infrastructure/runtime/config/config-store.js");
  const file = getGlobalConfigFilePath();
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.computerUse = computerUse;
  fs.writeFileSync(file, JSON.stringify(stored));
  expect(getGlobalConfig().computerUse?.enabled).toBe(computerUse?.enabled === true);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).computerUse).toEqual(computerUse);
});
