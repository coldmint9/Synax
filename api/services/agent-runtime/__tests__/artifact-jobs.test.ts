import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  enqueueArtifactJob,
  getArtifactJob,
  cancelArtifactJob,
  retryArtifactJob,
  processArtifactJobs,
} from "../artifact-jobs.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { setSessionWorkspaceRoot } from "../tools/workspace.js";
import * as compiler from "../artifacts/compiler.js";
import { listArtifacts } from "../artifacts/publisher.js";
let root: string, id: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-job-"));
  fs.writeFileSync(path.join(root, "demo.html"), "<h1>demo</h1>");
  id = agentSessionRuntime.create(executorInput).id;
  setSessionWorkspaceRoot(id, root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const input = (key = "one") => ({
  sourcePath: "demo.html",
  title: "Demo",
  sourceKind: "html" as const,
  idempotencyKey: key,
});
it("returns queued before compilation and idempotently cancels a queued job", async () => {
  const job = enqueueArtifactJob(id, input());
  expect(job.status).toBe("queued");
  expect(enqueueArtifactJob(id, input()).jobId).toBe(job.jobId);
  expect(cancelArtifactJob(id, job.jobId).status).toBe("cancelled");
  await processArtifactJobs();
  expect(listArtifacts(id)).toEqual([]);
  expect(() =>
    getArtifactJob(agentSessionRuntime.create(executorInput).id, job.jobId),
  ).toThrow(/not found/);
});
it("fences a running compiler after cancellation; retry creates exactly one ready revision", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const original = compiler.compileArtifact;
  vi.spyOn(compiler, "compileArtifact").mockImplementationOnce(
    async (...args) => {
      await gate;
      return original(...args);
    },
  );
  const job = enqueueArtifactJob(id, input());
  const running = processArtifactJobs();
  await vi.waitFor(() =>
    expect(getArtifactJob(id, job.jobId).status).toBe("building"),
  );
  expect(cancelArtifactJob(id, job.jobId).status).toBe("cancelled");
  release();
  await running;
  expect(listArtifacts(id)).toEqual([]);
  expect(getArtifactJob(id, job.jobId).status).toBe("cancelled");
  expect(retryArtifactJob(id, job.jobId).attempt).toBe(2);
  await processArtifactJobs();
  await vi.waitFor(() =>
    expect(getArtifactJob(id, job.jobId).status).toBe("ready"),
  );
  expect(listArtifacts(id)).toHaveLength(1);
  expect(cancelArtifactJob(id, job.jobId).status).toBe("ready");
});
it("retains diagnostics for failed jobs without publishing an invalid card", async () => {
  fs.writeFileSync(
    path.join(root, "demo.html"),
    '<iframe src="https://example.com"></iframe>',
  );
  const job = enqueueArtifactJob(id, input());
  await processArtifactJobs();
  expect(getArtifactJob(id, job.jobId)).toMatchObject({
    status: "failed",
    errorCode: "POLICY_BLOCKED",
  });
  expect(listArtifacts(id)).toEqual([]);
});
it("recovers an interrupted captured job after restart without reading changed workspace files", async () => {
  const { getRawSqlite } = await import("../../../db/index.js");
  const { beginBuild, persistBuildSnapshot } =
    await import("../artifacts/store.js");
  const { readSnapshot } = await import("../artifacts/snapshot.js");
  const { recoverArtifacts } = await import("../artifact-recovery.js");
  const job = enqueueArtifactJob(id, input());
  const db = getRawSqlite();
  db.prepare(
    "UPDATE artifact_jobs SET status='building',lease_until=? WHERE id=?",
  ).run(Date.now() - 1, job.jobId);
  const attempt = beginBuild(
    {
      sessionId: id,
      projectId: "project-alpha",
      workspaceRoot: root,
      jobId: job.jobId,
    },
    { ...input(), idempotencyKey: `job:${job.jobId}:1` },
  );
  persistBuildSnapshot(attempt.id, readSnapshot(root, "demo.html").files());
  db.prepare("UPDATE agent_artifact_builds SET lease_until=? WHERE id=?").run(
    Date.now() - 1,
    attempt.id,
  );
  fs.writeFileSync(
    path.join(root, "demo.html"),
    "<h1>Changed after crash</h1>",
  );
  // A new HTTP publication can drain the queue before the periodic recovery tick.
  await processArtifactJobs();
  expect(getArtifactJob(id, job.jobId).status).toBe("building");
  await recoverArtifacts();
  const ready = getArtifactJob(id, job.jobId);
  expect(ready.status).toBe("ready");
  const { getArtifactSource } = await import("../artifacts/publisher.js");
  expect(getArtifactSource(id, ready.revisionId!)[0].content).toBe(
    "<h1>demo</h1>",
  );
});
it("fails an expired job that never captured bytes instead of waiting forever", async () => {
  const { getRawSqlite } = await import("../../../db/index.js");
  const { beginBuild } = await import("../artifacts/store.js");
  const { recoverArtifacts } = await import("../artifact-recovery.js");
  const job = enqueueArtifactJob(id, input());
  const db = getRawSqlite();
  db.prepare(
    "UPDATE artifact_jobs SET status='building',lease_until=1 WHERE id=?",
  ).run(job.jobId);
  const build = beginBuild(
    {
      sessionId: id,
      projectId: "project-alpha",
      workspaceRoot: root,
      jobId: job.jobId,
    },
    { ...input(), idempotencyKey: `job:${job.jobId}:1` },
  );
  db.prepare("UPDATE agent_artifact_builds SET lease_until=1 WHERE id=?").run(
    build.id,
  );
  await recoverArtifacts();
  expect(getArtifactJob(id, job.jobId)).toMatchObject({
    status: "failed",
    errorCode: "BUILD_INTERRUPTED",
  });
  expect(listArtifacts(id)).toEqual([]);
});
it("moves a pending approval back to publishing on explicit retry and refuses rejected approval", async () => {
  const { getRawSqlite } = await import("../../../db/index.js");
  const { requestArtifactPublication } =
    await import("../artifact-authorization.js");
  const { recoverArtifacts } = await import("../artifact-recovery.js");
  const job = enqueueArtifactJob(id, input());
  cancelArtifactJob(id, job.jobId);
  const request = requestArtifactPublication(id, input(), null, null);
  const db = getRawSqlite();
  db.prepare(
    "UPDATE artifact_publication_requests SET job_id=? WHERE id=?",
  ).run(job.jobId, request);
  retryArtifactJob(id, job.jobId);
  expect(
    db
      .prepare("SELECT status FROM artifact_publication_requests WHERE id=?")
      .get(request),
  ).toMatchObject({ status: "publishing" });
  await processArtifactJobs();
  await recoverArtifacts();
  expect(
    db
      .prepare("SELECT status FROM artifact_publication_requests WHERE id=?")
      .get(request),
  ).toMatchObject({ status: "ready" });
  const other = enqueueArtifactJob(id, input("two"));
  cancelArtifactJob(id, other.jobId);
  db.prepare(
    "UPDATE artifact_publication_requests SET job_id=?,status='rejected' WHERE id=?",
  ).run(other.jobId, request);
  expect(() => retryArtifactJob(id, other.jobId)).toThrow(/rejected/);
});
it("agent child publishers leave durable jobs queued for the owning API host", async () => {
  vi.stubEnv("SYNAX_AGENT_SESSION_CHILD", "1");
  try {
    const job = enqueueArtifactJob(id, input());
    await processArtifactJobs();
    expect(getArtifactJob(id, job.jobId).status).toBe("queued");
    cancelArtifactJob(id, job.jobId);
  } finally {
    vi.unstubAllEnvs();
  }
});
it("refuses a recovered captured snapshot if the current root workflow is now read-only", async () => {
  const { getRawSqlite } = await import("../../../db/index.js");
  const { beginBuild, persistBuildSnapshot } =
    await import("../artifacts/store.js");
  const { readSnapshot } = await import("../artifacts/snapshot.js");
  const { recoverArtifacts } = await import("../artifact-recovery.js");
  const { agentRuntimeStore } = await import("../session-store.js");
  const job = enqueueArtifactJob(id, input());
  const db = getRawSqlite();
  db.prepare(
    "UPDATE artifact_jobs SET status='building',lease_until=1 WHERE id=?",
  ).run(job.jobId);
  const build = beginBuild(
    {
      sessionId: id,
      projectId: "project-alpha",
      workspaceRoot: root,
      jobId: job.jobId,
    },
    { ...input(), idempotencyKey: `job:${job.jobId}:1` },
  );
  persistBuildSnapshot(build.id, readSnapshot(root, "demo.html").files());
  db.prepare("UPDATE agent_artifact_builds SET lease_until=1 WHERE id=?").run(
    build.id,
  );
  agentRuntimeStore.updateSessionMetadata(id, { mode: "plan" });
  await recoverArtifacts();
  expect(getArtifactJob(id, job.jobId)).toMatchObject({
    status: "failed",
    errorCode: "PERMISSION_DENIED",
  });
  expect(listArtifacts(id)).toEqual([]);
});
it("fences a permission tightening during an ordinary compilation at commit", async () => {
  const { agentRuntimeStore } = await import("../session-store.js");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = compiler.compileArtifact;
  vi.spyOn(compiler, "compileArtifact").mockImplementationOnce(
    async (...args) => {
      const result = await original(...args);
      await gate;
      return result;
    },
  );
  const job = enqueueArtifactJob(id, input());
  const operation = processArtifactJobs();
  await vi.waitFor(() =>
    expect(getArtifactJob(id, job.jobId).status).toBe("building"),
  );
  agentRuntimeStore.updateSessionMetadata(id, { mode: "plan" });
  release();
  await operation;
  expect(getArtifactJob(id, job.jobId)).toMatchObject({
    status: "failed",
    errorCode: "PERMISSION_DENIED",
  });
  expect(listArtifacts(id)).toEqual([]);
});
