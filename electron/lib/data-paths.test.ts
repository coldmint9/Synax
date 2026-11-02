import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/test-home" } }));
import { getDataRoot } from "./data-paths.js";

afterEach(() => vi.unstubAllEnvs());

it("uses Synax's own runtime directory by default", () => {
  vi.stubEnv("DATA_ROOT", undefined);
  expect(getDataRoot()).toBe(path.join("/test-home", ".synax", "v2"));
});

it("resolves an explicit data root", () => {
  vi.stubEnv("DATA_ROOT", "custom-profile");
  expect(getDataRoot()).toBe(path.resolve("custom-profile"));
});
