import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ToolRegistry } from "../tool-registry.js";
import { AgentPermissionError } from "../runtime-errors.js";
import type { PatchDiagnostic } from "../tools/patch-diagnostics.js";
import { clearSessionWorkspaceRoot, setSessionWorkspaceRoot } from "../tools/workspace.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let root: string;
let sessionId: string;
let registry: ToolRegistry;
const original = "export const SOURCE_SENTINEL = 1;\n";
const stalePatch = [
  "*** Begin Patch",
  "*** Add File: should-not-exist.ts",
  "+export const staged = true;",
  "*** Update File: source.ts",
  "@@",
  "-export const SOURCE_SENTINEL = 999;",
  "+export const SOURCE_SENTINEL = 2;",
  "*** End Patch",
].join("\n");

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-patch-diagnostics-"));
  fs.writeFileSync(path.join(root, "source.ts"), original);
  sessionId = agentSessionRuntime.create({ ...executorInput, permissionTier: "unrestricted" }).id;
  setSessionWorkspaceRoot(sessionId, root);
  registry = new ToolRegistry();
});

afterEach(async () => {
  await store.flush();
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("file.patch diagnostic propagation", () => {
  it("persists the first failure and recovery without writing any staged file", async () => {
    const result = await registry.execute(sessionId, "file.patch", { patch: stalePatch }, {
      modelToolCallId: "provider-patch-1",
    });
    expect(result.record.status, result.record.error ?? "").toBe("failed");
    expect(result.record.modelToolCallId).toBe("provider-patch-1");
    const diagnostic = result.record.outputRef as PatchDiagnostic;
    expect(diagnostic).toMatchObject({
      error: true, code: "PATCH_CONTEXT_MISMATCH", applied: false,
      path: "source.ts", hunkIndex: expect.any(Number),
      recovery: expect.any(String),
      suggestedRead: { path: "source.ts", startLine: expect.any(Number), lineCount: expect.any(Number) },
    });
    expect(diagnostic.hunkIndex).toBeGreaterThanOrEqual(1);
    expect(diagnostic.suggestedRead!.startLine).toBeGreaterThanOrEqual(1);
    expect(diagnostic.recovery.length).toBeGreaterThan(0);
    expect(diagnostic.message).toContain("Failed to find expected lines");
    expect(JSON.parse(result.record.error!)).toEqual(diagnostic);
    expect(result.toolResult).toMatchObject({ outcome: "failed", result: diagnostic, artifacts: [] });
    expect(store.listToolCalls(sessionId)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "should-not-exist.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "source.ts"), "utf8")).toBe(original);

    const event = store.listEvents(sessionId).find(event =>
      event.type === "tool_result" && event.payload.toolCallId === result.record.id,
    )!;
    expect(event).toBeDefined();
    expect(event.payload).toMatchObject({
      toolCallId: result.record.id, toolId: "file.patch", status: "failed",
      code: diagnostic.code, hunkIndex: diagnostic.hunkIndex, applied: false,
    });
    expect(event.summary).toBe("file.patch failed: PATCH_CONTEXT_MISMATCH");
    expect(JSON.stringify(event)).not.toContain("SOURCE_SENTINEL");
    for (const key of ["error", "message", "anchor", "expectedExcerpt", "actualExcerpt", "recovery", "path"])
      expect(event.payload).not.toHaveProperty(key);

    await store.flushSession(sessionId);
    await store.hydrateSession(sessionId, true);
    expect(store.getToolCall(sessionId, result.record.id).outputRef).toEqual(diagnostic);
    expect(store.listEvents(sessionId)).toContainEqual(expect.objectContaining({
      type: "tool_result", payload: expect.objectContaining({ toolCallId: result.record.id, code: diagnostic.code }),
    }));

    // Recovery is a new explicit read and corrected patch, not an automatic retry.
    const read = await registry.execute(sessionId, "file.read", diagnostic.suggestedRead!);
    expect(read.record.status, read.record.error ?? "").toBe("completed");
    expect(read.record.outputRef).toMatchObject({ content: original, startLine: 1, lineComplete: true });
    const corrected = await registry.execute(sessionId, "file.patch", {
      patch: stalePatch.replace("SOURCE_SENTINEL = 999", "SOURCE_SENTINEL = 1"),
    });
    expect(corrected.record.status, corrected.record.error ?? "").toBe("completed");
    expect(store.listToolCalls(sessionId).map(call => [call.toolId, call.status])).toEqual([
      ["file.patch", "failed"], ["file.read", "completed"], ["file.patch", "completed"],
    ]);
    expect(fs.readFileSync(path.join(root, "source.ts"), "utf8")).toBe("export const SOURCE_SENTINEL = 2;\n");
  });

  it("preserves format diagnostics raised before the patch executor", async () => {
    const result = await registry.execute(sessionId, "file.patch", { patch: "not a patch envelope" });
    expect(result.record).toMatchObject({ status: "failed", outputRef: {
      error: true, code: "PATCH_INVALID_FORMAT", applied: false, recovery: expect.any(String),
    } });
    expect(result.toolResult?.result).toEqual(result.record.outputRef);
    expect(fs.readFileSync(path.join(root, "source.ts"), "utf8")).toBe(original);
  });

  it.each([
    ["unread", "unknown"], ["full", "unchanged"], ["changed", "changed"], ["partial", "unknown"],
  ])("reports %s read evidence without advancing the baseline", async (mode, expected) => {
    if (mode !== "unread") {
      const read = await registry.execute(sessionId, "file.read", {
        path: "source.ts", ...(mode === "partial" ? { maxBytes: 4 } : {}),
      });
      expect(read.record.status, read.record.error ?? "").toBe("completed");
    }
    if (mode === "changed") fs.appendFileSync(path.join(root, "source.ts"), "// unrelated update\n");
    const failed = await registry.execute(sessionId, "file.patch", { patch: stalePatch });
    expect(failed.record.outputRef).toMatchObject({ readBaseline: expected, applied: false });
    const again = await registry.execute(sessionId, "file.patch", { patch: stalePatch });
    expect(again.record.outputRef).toMatchObject({ readBaseline: expected });
    // Changes elsewhere never become a whole-file stale rejection for patch.
    const corrected = await registry.execute(sessionId, "file.patch", {
      patch: stalePatch.replace("SOURCE_SENTINEL = 999", "SOURCE_SENTINEL = 1"),
    });
    expect(corrected.record.status, corrected.record.error ?? "").toBe("completed");
    if (mode === "changed")
      expect(fs.readFileSync(path.join(root, "source.ts"), "utf8")).toContain("// unrelated update");
  });

  it("keeps approval pending instead of interpreting unapproved patch content", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const result = await registry.execute(session.id, "file.patch", { patch: stalePatch });
    expect(result.record).toMatchObject({ status: "pending", outputRef: null });
    expect(result.permission?.action).toBe("ask");
    expect(result.toolResult).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "source.ts"), "utf8")).toBe(original);
  });

  it.each([
    [new Error("ordinary execution failure"), "failed"],
    [new AgentPermissionError("permission revoked"), "denied"],
    [new Error(JSON.stringify({ error: true, code: "PATCH_CONTEXT_MISMATCH", applied: false, recovery: "read again" })), "failed"],
  ] as const)("does not classify other Error instances as patch diagnostics (%s)", async (error, status) => {
    registry.register({ ...registry.get("file.patch"), execute() { throw error; } });
    const result = await registry.execute(sessionId, "file.patch", {
      patch: "*** Begin Patch\n*** Add File: unused.ts\n+unused\n*** End Patch",
    });
    expect(result.record).toMatchObject({ status, error: error.message, outputRef: null });
    expect(result.toolResult).toBeUndefined();
    expect(fs.existsSync(path.join(root, "unused.ts"))).toBe(false);
    expect(store.listEvents(sessionId)).toContainEqual(expect.objectContaining({
      type: "tool_result", payload: expect.objectContaining({ error: error.message, status }),
    }));
  });
});
