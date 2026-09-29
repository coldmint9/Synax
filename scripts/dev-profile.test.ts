import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevProfileEnvironment } from "./dev-profile-config.js";

describe("resolveDevProfileEnvironment", () => {
  it("isolates the web development profile from the production desktop profile", () => {
    expect(
      resolveDevProfileEnvironment("web-dev", "web", {
        homeDir: "/Users/tester",
        env: {},
      }),
    ).toEqual({
      SYNAX_PROFILE: "web-dev",
      DATA_ROOT: path.join("/Users/tester", ".synax", "web-dev"),
      PORT: "3211",
      WEB_PORT: "5174",
    });
  });

  it("uses the desktop development web port while isolating its data root", () => {
    expect(
      resolveDevProfileEnvironment("desktop-dev", "desktop", {
        homeDir: "/Users/tester",
        env: {},
      }),
    ).toEqual({
      SYNAX_PROFILE: "desktop-dev",
      DATA_ROOT: path.join("/Users/tester", ".synax", "desktop-dev"),
      WEB_PORT: "5173",
    });
  });

  it("preserves explicit data and port overrides", () => {
    expect(
      resolveDevProfileEnvironment("custom", "web", {
        homeDir: "/Users/tester",
        env: {
          DATA_ROOT: "/tmp/synax-custom",
          PORT: "4301",
          WEB_PORT: "4302",
        },
      }),
    ).toEqual({
      SYNAX_PROFILE: "custom",
      DATA_ROOT: "/tmp/synax-custom",
      PORT: "4301",
      WEB_PORT: "4302",
    });
  });

  it("uses the current home directory when no home directory is provided", () => {
    expect(
      resolveDevProfileEnvironment("web-dev", "web", { env: {} }).DATA_ROOT,
    ).toBe(path.join(os.homedir(), ".synax", "web-dev"));
  });
});
