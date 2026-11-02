import { describe, expect, it } from "vitest";
import {
  SynaxModePromptRegistry,
  SynaxModePromptStrategy,
  buildSynaxRuntimeState,
  synaxModePromptRegistry,
  type SynaxModePromptContext,
} from "../synax-mode-prompt.js";
import {
  SYNAX_SESSION_MODES,
  inferSynaxSessionMode,
  parseSynaxSessionMode,
} from "../synax-session-mode.js";

class SuperPromptStrategy extends SynaxModePromptStrategy {
  readonly mode = "super" as const;
  buildSection(_context: SynaxModePromptContext): string {
    return "Session mode: super.";
  }
}

describe("super session mode", () => {
  it("registers super next to the existing modes", () => {
    expect(SYNAX_SESSION_MODES).toContain("super");
    expect([...SYNAX_SESSION_MODES]).toEqual([
      "chat",
      "plan",
      "goal",
      "plan_node",
      "super",
    ]);
  });

  it("parses and infers the stored super mode", () => {
    expect(parseSynaxSessionMode({ mode: "super" })).toBe("super");
    expect(
      inferSynaxSessionMode({
        profileId: "synax",
        sessionMetadata: { mode: "super" },
      }),
    ).toBe("super");
  });

  it("keeps the existing chat and legacy goal inference untouched", () => {
    expect(
      inferSynaxSessionMode({ profileId: "synax", sessionMetadata: {} }),
    ).toBe("chat");
    expect(
      inferSynaxSessionMode({ profileId: "synax", sessionMetadata: null }),
    ).toBe("chat");
    expect(
      inferSynaxSessionMode({ profileId: "goal", sessionMetadata: null }),
    ).toBe("goal");
    expect(
      inferSynaxSessionMode({
        profileId: "synax",
        sessionMetadata: { source: "plan-execution" },
      }),
    ).toBe("plan_node");
  });

  it("rejects unknown stored modes instead of coercing them", () => {
    expect(parseSynaxSessionMode({ mode: "supercoding" })).toBeNull();
  });

  it("lets a composition root register a mode strategy", () => {
    const registry = new SynaxModePromptRegistry();
    registry.register(new SuperPromptStrategy());
    expect(
      registry.buildSection({
        mode: "super",
        metadata: {},
        prompt: "",
      }),
    ).toBe("Session mode: super.");
  });

  it("still falls back to chat for modes without a strategy", () => {
    const registry = new SynaxModePromptRegistry();
    expect(
      registry.buildSection({ mode: "super", metadata: {}, prompt: "" }),
    ).toContain("Session mode: chat");
  });

  it("keeps volatile state out of the system section and in the tail reminder", () => {
    class RuntimeStateStrategy extends SynaxModePromptStrategy {
      readonly mode = "super" as const;
      buildSection(): string {
        return "Session mode: super.";
      }
      buildRuntimeState(): string {
        return "## Current graph (rev 9, running)";
      }
    }
    synaxModePromptRegistry.register(new RuntimeStateStrategy());

    const system = synaxModePromptRegistry.buildSection({
      mode: "super",
      metadata: {},
      prompt: "",
    });
    expect(system).not.toContain("Current graph");

    const tail = buildSynaxRuntimeState({
      mode: "super",
      metadata: {},
      prompt: "",
    });
    expect(tail).toContain("## Current graph (rev 9, running)");
  });
});

