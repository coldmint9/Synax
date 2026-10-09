import { afterEach, expect, it, vi } from "vitest";
import { nsisConfiguration } from "./build-nsis-installer.js";

afterEach(() => vi.unstubAllEnvs());
it("keeps NSIS separate from Squirrel assets and preserves user data", () => {
  const config = nsisConfiguration("1.12.0", "x64");
  expect(config.appId).toBe("com.Synax.desktop");
  expect(config.artifactName).toBe("Synax-1.12.0-win32-x64-NSIS.exe");
  expect(config.directories?.output).toBe("out/make/nsis");
  expect(config.nsis).toMatchObject({ deleteAppDataOnUninstall: false, differentialPackage: false });
  expect(config.publish).toBeNull();
});
it("retains the configured Windows publisher for signature verification", () => {
  vi.stubEnv("SYNAX_WINDOWS_PUBLISHER", "Synax Publisher");
  expect(nsisConfiguration("1.12.0", "arm64").win?.publisherName).toBe("Synax Publisher");
});
it("rejects invalid version and unsupported architecture", () => {
  expect(() => nsisConfiguration("../escape", "x64")).toThrow();
  expect(() => nsisConfiguration("1.12.0", "ia32")).toThrow();
});
