import fs from "node:fs";
import { Hono } from "hono";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { artifactVersionRoutes } from "../artifact-versions.js";
import { agentSessionRuntime } from "../../services/agent-runtime/session-runtime.js";
import { agentRuntimeStore } from "../../services/agent-runtime/session-store.js";
import { publishSessionArtifact } from "../../services/agent-runtime/artifact-integration.js";
import { setSessionWorkspaceRoot } from "../../services/agent-runtime/tools/workspace.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "../../services/agent-runtime/__tests__/agent-runtime-fixtures.js";
vi.mock("../../services/agent-runtime/run-coordinator.js", () => ({
  runCoordinator: { dispatchQueuedInput: vi.fn() },
}));
let root: string,
  sessionId: string,
  base: string,
  revisionId: string,
  artifactId: string;
const request = (
  url: string,
  data?: unknown,
  action?: string,
  method = "POST",
) =>
  artifactVersionRoutes.request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(action ? { "X-Synax-Artifact-Action": action } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-version-route-"));
  sessionId = agentSessionRuntime.create(executorInput).id;
  setSessionWorkspaceRoot(sessionId, root);
  base = `/sessions/${sessionId}/artifacts`;
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Stored version</h1>");
  const revision = await publishSessionArtifact(sessionId, {
    sourcePath: "index.html",
    sourceKind: "html",
    title: "Original",
    idempotencyKey: "original",
  });
  revisionId = revision.revisionId;
  artifactId = revision.artifactId;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("requires explicit fork confirmation and publishes exactly once through the durable transcript outbox", async () => {
  const url = `${base}/revisions/${revisionId}/fork`,
    body = { title: "Branch", idempotencyKey: "fork-key" };
  expect((await request(url, body)).status).toBe(403);
  fs.unlinkSync(path.join(root, "index.html"));
  const response = await request(url, body, "confirm-fork");
  expect(response.status).toBe(201);
  const { revision } = await response.json();
  expect((await request(url, body, "confirm-fork")).status).toBe(201);
  expect(
    agentRuntimeStore
      .listMessages(sessionId)
      .filter((m) => m.metadata?.source === "artifact_publisher"),
  ).toHaveLength(2);
  const history = await (
    await artifactVersionRoutes.request(
      `${base}/${revision.artifactId}/versions`,
    )
  ).json();
  expect(history.derivedFrom.revisionId).toBe(revisionId);
  expect(history.revisions[0].artifactId).not.toBe(artifactId);
  expect(
    (
      await request(
        url,
        { ...body, projectId: "evil", workspaceRoot: "/" },
        "confirm-fork",
      )
    ).status,
  ).toBe(400);
});
it("registers host schemas, reviews compatibility without state data, and requires confirmed inheritance with CAS", async () => {
  const fork = await (
    await request(
      `${base}/revisions/${revisionId}/fork`,
      { title: "Branch", idempotencyKey: "fork" },
      "confirm-fork",
    )
  ).json();
  const target = fork.revision.revisionId;
  const schema = { schemaVersion: 1, controls: [] };
  for (const id of [revisionId, target]) {
    expect(
      (
        await request(
          `${base}/revisions/${id}/control-schema`,
          schema,
          undefined,
          "PUT",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `${base}/revisions/${id}/control-schema`,
          schema,
          "register-control-schema",
          "PUT",
        )
      ).status,
    ).toBe(200);
  }
  const review = await (
    await artifactVersionRoutes.request(
      `${base}/revisions/${target}/inheritance?sourceRevisionId=${revisionId}`,
    )
  ).json();
  expect(review).toMatchObject({
    compatible: true,
    sourceEtag: 0,
    expectedEtag: 0,
  });
  const body = { sourceRevisionId: revisionId, sourceEtag: 0, expectedEtag: 0 };
  expect(
    (await request(`${base}/revisions/${target}/inherit-state`, body)).status,
  ).toBe(403);
  expect(
    (
      await request(
        `${base}/revisions/${target}/inherit-state`,
        body,
        "confirm-inherit-state",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `${base}/revisions/${target}/inherit-state`,
        body,
        "confirm-inherit-state",
      )
    ).status,
  ).toBe(409);
});
it("denies cross-session revision, schema, lineage and source access and handles malformed inputs safely", async () => {
  const other = agentSessionRuntime.create(executorInput).id;
  const otherBase = `/sessions/${other}/artifacts`;
  expect(
    (await artifactVersionRoutes.request(`${otherBase}/${artifactId}/versions`))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `${otherBase}/revisions/${revisionId}/fork`,
        { title: "X", idempotencyKey: "x" },
        "confirm-fork",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        `${otherBase}/revisions/${revisionId}/control-schema`,
        { schemaVersion: 1, controls: [] },
        "register-control-schema",
        "PUT",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await artifactVersionRoutes.request(
        `${otherBase}/revisions/${revisionId}/inheritance?sourceRevisionId=${revisionId}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await artifactVersionRoutes.request(
        `${base}/revisions/${revisionId}/inheritance`,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        `${base}/revisions/${revisionId}/fork`,
        { title: "x".repeat(70000), idempotencyKey: "x" },
        "confirm-fork",
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await artifactVersionRoutes.request(
        `${base}/revisions/${revisionId}/fork`,
        {
          method: "POST",
          headers: { "X-Synax-Artifact-Action": "confirm-fork" },
          body: "{",
        },
      )
    ).status,
  ).toBe(400);
});

it("returns initialized state and etag for explicit schema versions and preserves it on retry", async () => {
  const url = `${base}/revisions/${revisionId}/control-schema`;
  const schema = { schemaVersion: 2, controls: [] };
  const response = await request(url, schema, "register-control-schema", "PUT");
  expect(response.status).toBe(200);
  const registered = await response.json();
  expect(registered).toEqual({
    schema,
    state: {
      schemaVersion: 2,
      etag: 1,
      privateState: null,
      modelState: null,
      controls: {},
    },
  });
  expect(
    await (await request(url, schema, "register-control-schema", "PUT")).json(),
  ).toEqual(registered);
  expect(
    (
      await request(
        url,
        { schemaVersion: 1, controls: [] },
        "register-control-schema",
        "PUT",
      )
    ).status,
  ).toBe(409);
  const fork = await (
    await request(
      `${base}/revisions/${revisionId}/fork`,
      { title: "v2 branch", idempotencyKey: "v2" },
      "confirm-fork",
    )
  ).json();
  const forkState = await request(
    `${base}/revisions/${fork.revision.revisionId}/control-schema`,
    schema,
    "register-control-schema",
    "PUT",
  );
  expect((await forkState.json()).state).toEqual(registered.state);
});

it.each(["before", "after"])(
  "does not impose version body limits on a sibling screenshot route mounted %s it",
  async (order) => {
    const app = new Hono();
    const screenshots = new Hono();
    screenshots.post(
      "/sessions/:sessionId/artifacts/revisions/:revisionId/screenshot",
      async (c) => c.json({ bytes: (await c.req.text()).length }),
    );
    if (order === "before") app.route("/", screenshots);
    app.route("/", artifactVersionRoutes);
    if (order === "after") app.route("/", screenshots);
    const response = await app.request(
      `${base}/revisions/${revisionId}/screenshot`,
      { method: "POST", body: "x".repeat(70 * 1024) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 70 * 1024 });
  },
);
it('keeps historical fork publication inside the selected workflow boundary',async()=>{
 agentRuntimeStore.updateSessionMetadata(sessionId,{mode:'plan'});
 expect((await request(`${base}/revisions/${revisionId}/fork`,{title:'Plan bypass',idempotencyKey:'plan-bypass'},'confirm-fork')).status).toBe(403);
});
