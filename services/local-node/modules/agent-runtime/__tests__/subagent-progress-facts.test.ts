import { describe, expect, it } from "vitest";
import {
  readSubagentProgressFacts,
  SUBAGENT_FACT_FAILED_TOOLS,
  SUBAGENT_FACT_TEXT_CHARS,
  SUBAGENT_FACT_WRITE_PATHS,
} from "../subagent-progress-facts.js";

const call = (overrides: Record<string, unknown>) =>
  ({
    id: `tc-${Math.random().toString(16).slice(2)}`,
    sessionId: "child",
    runId: "run",
    stepId: null,
    modelToolCallId: null,
    toolId: "bash",
    category: "command",
    mutability: "read",
    argsHash: "h",
    inputSummary: "",
    inputRef: null,
    outputSummary: null,
    outputRef: null,
    status: "completed",
    permissionDecisionId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    error: null,
    ...overrides,
  }) as never;

const message = (overrides: Record<string, unknown>) =>
  ({
    id: `msg-${Math.random().toString(16).slice(2)}`,
    sessionId: "child",
    runId: "run",
    stepId: null,
    role: "assistant",
    content: "",
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as never;

const run = (overrides: Record<string, unknown>) =>
  ({
    id: "run",
    sessionId: "child",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    triggerMessageId: null,
    currentStep: 0,
    stopReason: null,
    model: null,
    metadata: {},
    ...overrides,
  }) as never;

const patch = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "*** Move to: src/b.ts",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

describe("subagent progress facts", () => {
  it("projects persisted counts, newest failures, write paths and the last text", () => {
    const facts = readSubagentProgressFacts("child", {
      listRuns: () => [
        run({ id: "run-2", status: "failed", startedAt: "2026-01-02T00:00:00.000Z" }),
        run({ id: "run-1", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      listRunToolCalls: (runId: string) =>
        runId === "run-1"
          ? [
              call({ toolId: "file.write", status: "completed", startedAt: "2026-01-01T00:01:00.000Z",
                inputRef: { path: "src/new.ts" } }),
              call({ toolId: "file.patch", status: "completed", startedAt: "2026-01-01T00:02:00.000Z",
                inputRef: { patch } }),
            ]
          : [
              call({ toolId: "bash", status: "failed", error: "boom", startedAt: "2026-01-02T00:01:00.000Z" }),
              call({ toolId: "file.write", status: "failed", error: "denied by policy",
                inputRef: { path: "src/never-written.ts" }, startedAt: "2026-01-02T00:02:00.000Z" }),
              call({ toolId: "run", status: "blocked", outputSummary: "waiting for approval",
                startedAt: "2026-01-02T00:03:00.000Z" }),
            ],
      listMessages: () => [
        message({ role: "user", content: "do the thing" }),
        message({ content: "x".repeat(SUBAGENT_FACT_TEXT_CHARS + 50), metadata: { partial: true } }),
      ],
    });

    expect(facts).toMatchObject({
      runs: 2,
      lastRunStatus: "failed",
      tools: { total: 5, completed: 2, failed: 2, blocked: 1 },
    });
    // Newest failure first, and each entry is the persisted error verbatim.
    expect(facts?.failedTools).toEqual([
      { tool: "run", error: "waiting for approval" },
      { tool: "file.write", error: "denied by policy" },
      { tool: "bash", error: "boom" },
    ]);
    // A failed write never counts as a write, and a move reports both paths.
    expect(facts?.writtenPaths).toEqual(["src/new.ts", "src/a.ts", "src/b.ts"]);
    expect(facts?.lastText).toEqual(
      expect.objectContaining({ partial: true }),
    );
    expect(facts?.lastText?.text).toHaveLength(SUBAGENT_FACT_TEXT_CHARS + 1);
    expect(facts?.lastText?.text.endsWith("…")).toBe(true);
  });

  it("bounds the samples without hiding the exact counts", () => {
    const many = Array.from({ length: SUBAGENT_FACT_FAILED_TOOLS + 4 }, (_, index) =>
      call({
        toolId: `tool-${index}`,
        status: "failed",
        error: `e${index}`,
        startedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }));
    const writes = Array.from({ length: SUBAGENT_FACT_WRITE_PATHS + 3 }, (_, index) =>
      call({
        toolId: "file.write",
        inputRef: { path: `src/${index}.ts` },
        startedAt: `2026-01-01T01:00:${String(index).padStart(2, "0")}.000Z`,
      }));
    const facts = readSubagentProgressFacts("child", {
      listRuns: () => [run({ status: "failed" })],
      listRunToolCalls: () => [...many, ...writes],
      listMessages: () => [],
    });
    expect(facts?.tools.failed).toBe(many.length);
    expect(facts?.failedTools).toHaveLength(SUBAGENT_FACT_FAILED_TOOLS);
    expect(facts?.failedTools[0]?.tool).toBe(`tool-${many.length - 1}`);
    expect(facts?.writtenPaths).toHaveLength(SUBAGENT_FACT_WRITE_PATHS);
  });

  it("returns null when the child left nothing durable", () => {
    expect(readSubagentProgressFacts("child", {
      listRuns: () => [],
      listRunToolCalls: () => [],
      listMessages: () => [],
    })).toBeNull();
  });

  it("degrades to null instead of failing the caller when storage is unreadable", () => {
    const facts = readSubagentProgressFacts("child", {
      listRuns: () => { throw new Error("store offline"); },
      listRunToolCalls: () => { throw new Error("store offline"); },
      listMessages: () => { throw new Error("store offline"); },
    });
    expect(facts).toBeNull();
  });
});
