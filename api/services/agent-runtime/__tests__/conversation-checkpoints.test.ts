import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { captureCheckpoint, listCheckpoints } from "../checkpoints/store.js";
import { withCheckpointMutation } from "../checkpoints/mutations.js";
import {
  applyHistory,
  previewHistory,
  checkpointSummary,
} from "../checkpoints/operations.js";
import { forkCheckpoint } from "../checkpoints/fork.js";
import { getRawSqlite } from "../../../db/index.js";
let root: string, sessionId: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-history-"));
  sessionId = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: root,
  }).id;
  store.updateSession(sessionId, { status: "completed" });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function message(id: string, role: "user" | "assistant", content = id) {
  store.appendMessage({
    id,
    sessionId,
    role,
    content,
    runId: null,
    stepId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  });
}
async function roundOne() {
  message("user1", "user");
  await fs.writeFile(path.join(root, "file"), "first");
  message("reply1", "assistant");
  const checkpoint = (await captureCheckpoint(sessionId, "reply", "reply1"))!;
  expect(checkpoint.payload.error).toBeUndefined();
  return checkpoint;
}
describe("conversation checkpoints", () => {
  it("restores files, history and compressed metadata together and is idempotent", async () => {
    const cp = await roundOne();
    message("user2", "user");
    await withCheckpointMutation(sessionId, () =>
      fs.writeFile(path.join(root, "file"), "second"),
    );
    message("reply2", "assistant");
    store.updateSessionMetadata(sessionId, {
      contextEpoch: { epoch: 99 },
      futureSecret: "must disappear",
    });
    expect((await previewHistory(sessionId, cp.id)).removedMessages).toBe(2);
    const request = {
      action: "rollback" as const,
      checkpointId: cp.id,
      revision: 0,
      requestId: "one",
    };
    const result = await applyHistory(sessionId, request);
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("first");
    expect(store.listMessages(sessionId).map((m) => m.id)).toEqual([
      "user1",
      "reply1",
    ]);
    expect(
      store.getSession(sessionId).sessionMetadata?.futureSecret,
    ).toBeUndefined();
    expect(await applyHistory(sessionId, request)).toEqual(result);
    expect(checkpointSummary(sessionId).revision).toBe(1);
  });
  it("rejects all mutations when a human edited an affected file", async () => {
    const cp = await roundOne();
    message("user2", "user");
    await withCheckpointMutation(sessionId, async () => {
      await fs.writeFile(path.join(root, "file"), "second");
      await fs.writeFile(path.join(root, "new"), "new");
    });
    await fs.writeFile(path.join(root, "file"), "human");
    expect((await previewHistory(sessionId, cp.id)).canApply).toBe(false);
    await expect(
      applyHistory(sessionId, {
        action: "rollback",
        checkpointId: cp.id,
        revision: 0,
        requestId: "conflict",
      }),
    ).rejects.toThrow("conflicts");
    expect(await fs.readFile(path.join(root, "new"), "utf8")).toBe("new");
    expect(store.listMessages(sessionId)).toHaveLength(3);
  });
  it("preserves unrelated manual files and records mutations from failed tools", async () => {
    const cp = await roundOne();
    await expect(
      withCheckpointMutation(sessionId, async () => {
        await fs.writeFile(path.join(root, "file"), "partial");
        throw new Error("failed command");
      }),
    ).rejects.toThrow("failed command");
    await fs.writeFile(path.join(root, "human"), "unrelated");
    await applyHistory(sessionId, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "failed-tool",
    });
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("first");
    expect(await fs.readFile(path.join(root, "human"), "utf8")).toBe(
      "unrelated",
    );
  });
  it("creates a historical isolated fork without affecting the source", async () => {
    const cp = await roundOne();
    await fs.writeFile(path.join(root, "file"), "present");
    message("user2", "user");
    const fork = await forkCheckpoint(sessionId, cp.id, 0, "fork-once");
    const forked = store.getSession(fork.sessionId),
      workDir = (forked.sessionMetadata?.backend as { workDir: string })
        .workDir;
    try {
      expect(workDir).not.toBe(root);
      expect(await fs.readFile(path.join(workDir, "file"), "utf8")).toBe(
        "first",
      );
      expect(store.listMessages(fork.sessionId).map((m) => m.content)).toEqual([
        "user1",
        "reply1",
      ]);
      expect(forked.parentSessionId).toBeNull();
      expect(forked.sessionMetadata?.forkedFromSessionId).toBe(sessionId);
      await fs.writeFile(path.join(workDir, "file"), "fork");
      expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe(
        "present",
      );
      expect(await forkCheckpoint(sessionId, cp.id, 0, "fork-once")).toEqual(
        fork,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
  it("rejects a stale revision and leaves old sessions copy-only", async () => {
    message("legacy", "user");
    expect(listCheckpoints(sessionId)).toEqual([]);
    const cp = await roundOne();
    await expect(
      applyHistory(sessionId, {
        action: "rollback",
        checkpointId: cp.id,
        revision: 5,
        requestId: "stale",
      }),
    ).rejects.toThrow("changed");
  });
  it("edits from the input boundary and queues exactly one replacement run", async () => {
    const cp = (await captureCheckpoint(sessionId, "input", "user1"))!;
    message("user1", "user", "original");
    await withCheckpointMutation(sessionId, () =>
      fs.writeFile(path.join(root, "created"), "future"),
    );
    message("reply1", "assistant");
    const request = {
      action: "edit" as const,
      checkpointId: cp.id,
      revision: 0,
      requestId: "edit",
      message: "replacement",
    };
    const result = await applyHistory(sessionId, request);
    expect(result.runId).toBeTruthy();
    expect(result.input?.message).toBe("replacement");
    expect(store.listMessages(sessionId)).toEqual([]);
    expect(store.getSession(sessionId).prompt).toBe("replacement");
    await expect(fs.stat(path.join(root, "created"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await applyHistory(sessionId, request)).toEqual(result);
    expect(store.listRuns(sessionId)).toHaveLength(1);
  });
  it("blocks recovery while a background writer has not stopped", async () => {
    const cp = await roundOne();
    getRawSqlite()
      .prepare(
        `INSERT INTO agent_runtime_processes(id,host_id,session_id,run_id,pid,process_group,command_label,state,started_at,kind) VALUES ('background','host',?,NULL,NULL,0,'server','unconfirmed',?,'background')`,
      )
      .run(sessionId, new Date().toISOString());
    await expect(previewHistory(sessionId, cp.id)).rejects.toThrow(
      "background",
    );
  });
});
