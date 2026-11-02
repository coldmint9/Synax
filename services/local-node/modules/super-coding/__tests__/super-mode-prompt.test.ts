import { describe, expect, it } from "vitest";
import {
  createEmptySuperGraph,
  type SuperNode,
} from "../../../../../packages/contracts/super-coding.js";
import {
  buildSuperGraphSection,
  buildSuperModeSection,
} from "../super-mode-prompt.js";

function node(id: string, overrides: Partial<SuperNode> = {}): SuperNode {
  return {
    id,
    title: `Task ${id}`,
    taskType: "implement",
    objective: `Objective ${id}`,
    deliverable: `Deliverable ${id}`,
    acceptance: [],
    scope: [],
    status: "queued",
    depth: 0,
    model: "model:implement",
    effort: "high",
    childSessionId: null,
    messages: 0,
    summary: null,
    error: null,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("super mode prompt", () => {
  it("states that runnable nodes start without a start command", () => {
    const section = buildSuperModeSection();

    expect(section).toContain("## Super mode");
    expect(section).toContain("start automatically");
    expect(section).toContain("Do not do the whole task yourself.");
    expect(section).not.toContain("Current graph");
  });

  it("routes intent through three lanes and keeps simple work unorchestrated", () => {
    const section = buildSuperModeSection();

    expect(section).toContain("Direct lane");
    expect(section).toContain("Graph lane");
    expect(section).toContain("Clarify lane");
    expect(section).toContain(
      "Never plan a node for work you could finish yourself in a few edits",
    );
  });

  it("makes clarification and the quality bar explicit", () => {
    const section = buildSuperModeSection();

    expect(section).toContain("### Ask before you commit");
    expect(section).toContain("`human.ask`");
    expect(section).toContain("never ask what a read can answer");
    expect(section).toContain("### Finish it perfectly");
    expect(section).toContain("A child's report is a pointer, never proof.");
    expect(section).toContain("No fabricated evidence");
  });

  it("declares the enforced workflow instead of an optional style", () => {
    const section = buildSuperModeSection();

    expect(section).toContain(
      "Super mode is this session's selected workflow, not an optional style.",
    );
    expect(section).toContain("Ad-hoc delegation is unavailable in this mode");
  });

  it("keeps the cached system section identical across graph revisions", () => {
    const first = buildSuperModeSection();
    const second = buildSuperModeSection();
    expect(first).toBe(second);
    expect(first).not.toContain("rev ");
  });

  it("adds a bounded live graph snapshot in the runtime reminder", () => {
    const graph = createEmptySuperGraph({
      sessionId: "session-1",
      now: "2026-10-29T00:00:00.000Z",
    });
    graph.nodes.push(
      node("a", {
        status: "running",
        childSessionId: "child-a",
        summary: "halfway",
      }),
      ...Array.from({ length: 14 }, (_, index) => node(`n${index}`)),
    );

    const section = buildSuperGraphSection(graph) ?? "";

    expect(section).toContain("## Current graph (rev 0, planning)");
    expect(section).toContain("- a [running] Task a: halfway");
    expect(section).toContain("- n10 [queued] Task n10");
    // At most 12 nodes are copied into the prompt.
    expect(section).not.toContain("- n11 [queued]");
    expect(section).not.toContain("Deliverable");
  });

  it("keeps failed and archived nodes out of the budget line", () => {
    const graph = createEmptySuperGraph({
      sessionId: "session-1",
      now: "2026-10-29T00:00:00.000Z",
    });
    graph.nodes.push(
      node("a", { status: "running", childSessionId: "child-a" }),
      node("b", { status: "failed", error: "child session ended as failed." }),
      node("c", { status: "archived" }),
    );

    const section = buildSuperGraphSection(graph) ?? "";

    // Only the running node holds a slot; the model must see free budget.
    expect(section).toContain("Nodes 1/8 slots in use");
    expect(section).toContain("- b [failed] Task b: child session ended as failed.");
    expect(buildSuperModeSection()).toContain(
      "A failed or archived node holds no slot",
    );
  });
});
