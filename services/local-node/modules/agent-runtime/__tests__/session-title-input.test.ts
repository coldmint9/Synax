import { describe, expect, it } from "vitest";
import {
  extractPlanNodeTitleFromPrompt,
  extractLegacyUserRequestFromPrompt,
  resolveSessionTitleInput,
} from "../session-title-input.js";

describe("session-title-input", () => {
  it("extracts user goal from direct mode prompt", () => {
    const prompt = [
      "Respond in English.",
      "",
      "## User Goal",
      "Fix auth token refresh",
      "",
      "## Wiki Context",
      "- Document: Auth",
    ].join("\n");

    expect(extractLegacyUserRequestFromPrompt(prompt)).toBe(
      "Fix auth token refresh",
    );
  });

  it("extracts plan node title from plan_node prompt", () => {
    const prompt = [
      "You are a Goal Agent",
      "",
      "## Plan Node",
      "- **Title**: Add redirect",
      "- **Description**: Redirect unauthenticated users",
    ].join("\n");

    expect(extractPlanNodeTitleFromPrompt(prompt)).toBe("Add redirect");
  });

  it("prefers goalContent from session metadata", () => {
    const source = resolveSessionTitleInput({
      sessionMetadata: { goalContent: "Ship dark mode toggle" },
      prompt: "## User Goal\nIgnored goal",
    });

    expect(source).toBe("Ship dark mode toggle");
  });

  it("prefers the current userPrompt over persisted legacy content", () => {
    expect(
      resolveSessionTitleInput({
        sessionMetadata: {
          userPrompt: "Current request",
          goalContent: "Old request",
        },
        prompt: "## User Goal\nFallback",
      }),
    ).toBe("Current request");
  });

  it("prefers planNodeTitle from session metadata", () => {
    const source = resolveSessionTitleInput({
      sessionMetadata: { planNodeTitle: "Setup database" },
      prompt: "- **Title**: Fallback title",
    });

    expect(source).toBe("Setup database");
  });

  it("falls back to prompt sections when metadata is missing", () => {
    expect(
      resolveSessionTitleInput({
        sessionMetadata: null,
        prompt: "## User Goal\nRefactor utils module\n\n## Instructions",
      }),
    ).toBe("Refactor utils module");

    expect(
      resolveSessionTitleInput({
        sessionMetadata: null,
        prompt:
          "## Plan Node\n- **Title**: Retry node\n- **Description**: Fix tests",
      }),
    ).toBe("Retry node");
  });
});
