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
import { checkpointFiles } from "../checkpoints/files.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { pruneCheckpointBlobs } from "../checkpoints/gc.js";
import { withSnapshotLease } from "../checkpoints/storage-leases.js";
import { applyHistory } from "../checkpoints/operations.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-maintenance-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const blob = (digest: string) =>
  path.join(
    checkpointFiles.directory,
    "blobs",
    digest.slice(0, 2),
    digest.slice(2),
  );
async function capture() {
  store.appendMessage({
    id: "reply",
    sessionId: id,
    role: "assistant",
    content: "ready",
    runId: null,
    stepId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  });
  return (await captureCheckpoint(id, "reply", "reply"))!;
}
describe("checkpoint maintenance", () => {
  it("collects old unreferenced blobs without deleting a live checkpoint", async () => {
    await fs.writeFile(path.join(root, "file"), "live checkpoint");
    const cp = await capture();
    const live = cp.payload.manifests![0].files.file.hash,
      orphan = await checkpointFiles.put(Buffer.from(`orphan-${id}`));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(blob(live), old, old);
    await fs.utimes(blob(orphan), old, old);
    expect(await pruneCheckpointBlobs()).toBeGreaterThanOrEqual(1);
    expect((await checkpointFiles.get(live)).toString()).toBe(
      "live checkpoint",
    );
    await expect(fs.stat(blob(orphan))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not collect concurrently with snapshot capture", async () => {
    expect(await withSnapshotLease(() => pruneCheckpointBlobs())).toBe(0);
  });
  it("never restores previously revoked permissions from historical state", async () => {
    const cp = await capture();
    const rules = [
      { gate: "write" as const, pattern: "*", action: "deny" as const },
    ];
    store.updateSession(id, {
      permissionRules: rules,
      sessionMetadata: {
        ...store.getSession(id).sessionMetadata,
        permissionTier: "readonly",
      },
    });
    await applyHistory(id, {
      checkpointId: cp.id,
      action: "rollback",
      revision: 0,
      requestId: "security",
    });
    expect(store.getSession(id).permissionRules).toEqual(rules);
    expect(store.getSession(id).sessionMetadata?.permissionTier).toBe(
      "readonly",
    );
  });
});
