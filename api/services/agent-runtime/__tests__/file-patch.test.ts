import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchTool } from "../tools/patch.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { toolRegistry } from "../tool-registry.js";
import { recordSessionFileRead } from "../read-tracker.js";
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from "../tools/workspace.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const sessionIds: string[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const sessionId of sessionIds.splice(0)) {
    clearSessionWorkspaceRoot(sessionId);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setupWorkspace(prefix: string): { sessionId: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const sessionId = `ars_file_patch_${sessionIds.length}`;
  sessionIds.push(sessionId);
  setSessionWorkspaceRoot(sessionId, dir);
  return { sessionId, dir };
}

function input(sessionId: string, patch: string) {
  return {
    sessionId,
    runId: null,
    stepId: null,
    toolCallId: "tool_file_patch_test",
    toolId: "file.patch",
    category: "write" as const,
    mutability: "write" as const,
    args: { patch },
  };
}

describe("patchTool", () => {
  it("applies add, update, move and delete hunks in one call", async () => {
    const { sessionId, dir } = setupWorkspace("Synax-file-patch-");
    fs.writeFileSync(
      path.join(dir, "keep.ts"),
      "export const keep = 1;\n",
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "drop.ts"), "obsolete\n", "utf8");
    fs.writeFileSync(
      path.join(dir, "old-name.ts"),
      "export const moved = true;\n",
      "utf8",
    );
    for (const file of ["keep.ts", "drop.ts", "old-name.ts"]) {
      recordSessionFileRead(sessionId, file);
    }

    const result = await patchTool.execute(
      input(
        sessionId,
        [
          "*** Begin Patch",
          "*** Add File: added.ts",
          "+export const added = true;",
          "*** Update File: keep.ts",
          "@@",
          "-export const keep = 1;",
          "+export const keep = 2;",
          "*** Update File: old-name.ts",
          "*** Move to: new-name.ts",
          "*** Delete File: drop.ts",
          "*** End Patch",
        ].join("\n"),
      ),
    );

    expect(fs.readFileSync(path.join(dir, "added.ts"), "utf8")).toBe(
      "export const added = true;\n",
    );
    expect(fs.readFileSync(path.join(dir, "keep.ts"), "utf8")).toBe(
      "export const keep = 2;\n",
    );
    expect(fs.readFileSync(path.join(dir, "new-name.ts"), "utf8")).toBe(
      "export const moved = true;\n",
    );
    expect(fs.existsSync(path.join(dir, "old-name.ts"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "drop.ts"))).toBe(false);
    expect(result.result).toEqual({
      files: [
        { path: "added.ts", action: "add" },
        { path: "keep.ts", action: "update" },
        { path: "old-name.ts", action: "update", movePath: "new-name.ts" },
        { path: "drop.ts", action: "delete" },
      ],
      bytes: expect.any(Number),
    });
  });

  it("aborts the whole patch when one hunk does not match", () => {
    const { sessionId, dir } = setupWorkspace("Synax-file-patch-stale-");
    fs.writeFileSync(
      path.join(dir, "keep.ts"),
      "export const keep = 1;\n",
      "utf8",
    );
    recordSessionFileRead(sessionId, "keep.ts");

    expect(() =>
      patchTool.execute(
        input(
          sessionId,
          [
            "*** Begin Patch",
            "*** Add File: should-not-exist.ts",
            "+export const nope = true;",
            "*** Update File: keep.ts",
            "@@",
            "-export const keep = 999;",
            "+export const keep = 2;",
            "*** End Patch",
          ].join("\n"),
        ),
      ),
    ).toThrow(/Failed to find expected lines/);

    expect(fs.existsSync(path.join(dir, "should-not-exist.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "keep.ts"), "utf8")).toBe(
      "export const keep = 1;\n",
    );
  });

  it("requires write permission approval through the registry", async () => {
    resetAgentRuntimeFixtures();
    const session = agentSessionRuntime.create(executorInput);
    const call = await toolRegistry.execute(session.id, "file.patch", {
      patch:
        "*** Begin Patch\n*** Delete File: tmp/agent-runtime-patch.txt\n*** End Patch",
    });

    expect(call.record.status).toBe("pending");
    expect(call.permission?.action).toBe("ask");
    expect(call.permission?.internalGate).toBe("write");
  });
});
