import { describe, expect, it } from "vitest";
import { buildSessionPrompt } from "../session-prompt.js";

describe("buildSessionPrompt", () => {

  it("builds plan_node mode with scoped instructions", () => {
    const prompt = buildSessionPrompt({
      mode: "plan_node",
      content: "Implement login redirect",
      node: {
        title: "Add redirect",
        description: "Redirect unauthenticated users to login",
        expectedFiles: ["src/auth.ts"],
        dependsOn: ["Setup"],
      },
      linkedGoals: [
        {
          id: "g1",
          scope: "project",
          content: "Fix auth",
        },
      ],
      completedNodes: [{ title: "Setup", summary: "Added config" }],
      locale: "en",
    });

    expect(prompt).toContain("## Plan Node");
    expect(prompt).toContain("Add redirect");
    expect(prompt).toContain("## Linked Goals");
    expect(prompt).toContain("[g1]");
    expect(prompt).toContain("## Completed Dependencies");
    expect(prompt).toContain("Setup: Added config");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("Keep changes within the requested scope");
    expect(prompt).toContain("You may use shell");
  });

  it("includes redo feedback in plan_node mode", () => {
    const prompt = buildSessionPrompt({
      mode: "plan_node",
      content: "Retry node",
      node: {
        title: "Retry",
        description: "Fix tests",
        expectedFiles: [],
        dependsOn: [],
      },
      redoFeedback: "Tests still failing on edge case",
      locale: "en",
    });

    expect(prompt).toContain("## Redo Feedback");
    expect(prompt).toContain("Tests still failing on edge case");
  });
});
