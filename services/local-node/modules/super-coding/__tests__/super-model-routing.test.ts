import { describe, expect, it, vi } from "vitest";
import {
  resolveSuperModel,
  type SuperCodingConfig,
} from "../../../../../packages/contracts/super-coding.js";

/**
 * The runtime adapter reads the pool from global config. Only that one call is
 * replaced, so the routing rule under test is the shipped one.
 */
const configState: { superCoding: SuperCodingConfig | undefined } = {
  superCoding: undefined,
};

vi.mock(
  "../../../infrastructure/runtime/config/config-store.js",
  () => ({
    getGlobalConfigForRuntime: () => ({
      superCoding: configState.superCoding,
    }),
  }),
);

const { createSuperRuntimeDeps } = await import("../super-runtime-adapter.js");

function pool(overrides: Partial<SuperCodingConfig> = {}): SuperCodingConfig {
  return {
    models: [],
    routes: [],
    defaultModel: "",
    maxNodes: 8,
    maxConcurrent: 5,
    ...overrides,
  };
}

describe("super model routing", () => {
  it("uses the first matching route before the pool default", () => {
    const config = pool({
      routes: [
        { taskTypes: ["implement"], model: "anthropic/claude-sonnet-4.5" },
        { taskTypes: ["implement", "verify"], model: "anthropic/claude-opus-4.5" },
      ],
      defaultModel: "anthropic/claude-haiku-4.5",
    });

    expect(resolveSuperModel(config, "implement")).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      source: "route",
    });
  });

  it("falls back to the pool default for an unrouted task type", () => {
    const config = pool({
      routes: [{ taskTypes: ["implement"], model: "anthropic/claude-sonnet-4.5" }],
      defaultModel: "anthropic/claude-haiku-4.5",
    });

    expect(resolveSuperModel(config, "review")).toEqual({
      model: "anthropic/claude-haiku-4.5",
      source: "default",
    });
  });

  it("inherits the session model when no pool is configured", () => {
    expect(resolveSuperModel(pool(), "implement")).toEqual({
      model: "",
      source: "inherit",
    });
  });

  it("routes nodes through the pool and inherits without one", () => {
    const deps = createSuperRuntimeDeps();

    configState.superCoding = undefined;
    expect(deps.modelFor("implement")).toBe("");
    expect(deps.modelFor("verify")).toBe("");

    configState.superCoding = pool({
      routes: [{ taskTypes: ["implement"], model: "anthropic/claude-sonnet-4.5" }],
      defaultModel: "anthropic/claude-haiku-4.5",
    });
    expect(deps.modelFor("implement")).toBe("anthropic/claude-sonnet-4.5");
    expect(deps.modelFor("verify")).toBe("anthropic/claude-haiku-4.5");
  });
});
