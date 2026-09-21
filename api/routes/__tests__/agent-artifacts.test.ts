import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { agentArtifactRoutes } from "../agent-artifacts.js";
import { agentSessionRuntime } from "../../services/agent-runtime/session-runtime.js";
import { agentRuntimeStore } from "../../services/agent-runtime/session-store.js";
import { setSessionWorkspaceRoot } from "../../services/agent-runtime/tools/workspace.js";
import { inputQueueService } from "../../services/agent-runtime/input-queue-service.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "../../services/agent-runtime/__tests__/agent-runtime-fixtures.js";
vi.mock("../../services/agent-runtime/run-coordinator.js", () => ({
  runCoordinator: { dispatchQueuedInput: vi.fn() },
}));
let root: string, sessionId: string, base: string;
const request = (
  url: string,
  data?: unknown,
  method = "POST",
  headers: Record<string, string> = {},
) =>
  agentArtifactRoutes.request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
beforeEach(() => {
  resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-artifacts-route-"));
  sessionId = agentSessionRuntime.create(executorInput).id;
  setSessionWorkspaceRoot(sessionId, root);
  base = `/sessions/${sessionId}/artifacts`;
  fs.writeFileSync(
    path.join(root, "demo.html"),
    '<button id="toggle">Mini</button><script>document.getElementById("toggle").addEventListener("click",e=>e.target.textContent="Detail")</script>',
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
async function publish() {
  const response = await request(base, {
    sourcePath: "demo.html",
    title: "Runtime card",
    sourceKind: "html",
    idempotencyKey: "publish-demo",
  });
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(202);
  let job = json.job;
  await vi.waitFor(async () => {
    job = (
      await (
        await agentArtifactRoutes.request(`${base}/jobs/${json.job.jobId}`)
      ).json()
    ).job;
    expect(job.status).toBe("ready");
  });
  return (
    await (
      await agentArtifactRoutes.request(
        `${base}/revisions/${job.revisionId}/bundle`,
      )
    ).json()
  ).revision;
}
describe("artifact route lifecycle", () => {
  it("publishes a durable reference once, serves JSON bundle and denies cross-session access", async () => {
    const revision = await publish();
    await publish();
    expect(
      agentRuntimeStore
        .listMessages(sessionId)
        .filter((m) => m.metadata?.source === "artifact_publisher"),
    ).toHaveLength(1);
    const response = await agentArtifactRoutes.request(
      `${base}/revisions/${revision.revisionId}/bundle`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect((await response.json()).html).toContain("Content-Security-Policy");
    const other = agentSessionRuntime.create(executorInput).id;
    expect(
      (
        await agentArtifactRoutes.request(
          `/sessions/${other}/artifacts/revisions/${revision.revisionId}/bundle`,
        )
      ).status,
    ).toBe(404);
  });
  it("rejects a draft, atomically enqueues confirmed feedback once", async () => {
    const revision = await publish();
    const url = `${base}/revisions/${revision.revisionId}/feedback`;
    const input = {
      text: "Make mini denser",
      parameters: { width: 320 },
      idempotencyKey: "qa-1",
    };
    expect((await request(url, input)).status).toBe(403);
    expect(inputQueueService.list(sessionId)).toEqual([]);
    expect(
      (
        await request(url, input, "POST", {
          "X-Synax-Artifact-Action": "confirm-feedback",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(url, input, "POST", {
          "X-Synax-Artifact-Action": "confirm-feedback",
        })
      ).status,
    ).toBe(200);
    // An unrelated enqueue/session REPLACE must not erase deduplication.
    agentRuntimeStore.updateSessionMetadata(sessionId, { qaProbe: true });
    expect(
      (
        await request(url, input, "POST", {
          "X-Synax-Artifact-Action": "confirm-feedback",
        })
      ).status,
    ).toBe(200);
    expect(inputQueueService.list(sessionId)).toHaveLength(1);
    expect(inputQueueService.list(sessionId)[0].message).toContain(
      revision.revisionId,
    );
    expect(
      (
        await request(url, { ...input, text: "changed" }, "POST", {
          "X-Synax-Artifact-Action": "confirm-feedback",
        })
      ).status,
    ).toBe(409);
  });
  it("state CAS, rejected path and attachment export", async () => {
    expect(
      (
        await request(base, {
          sourcePath: "../secrets",
          title: "bad",
          sourceKind: "html",
          idempotencyKey: "bad",
        })
      ).status,
    ).toBe(400);
    const revision = await publish();
    const url = `${base}/revisions/${revision.revisionId}/state`;
    const state = {
      privateState: { expanded: true },
      modelState: null,
      controls: {},
      schemaVersion: 1,
      expectedEtag: 0,
    };
    expect((await request(url, state, "PUT")).status).toBe(200);
    expect((await request(url, state, "PUT")).status).toBe(409);
    const exported = await agentArtifactRoutes.request(
      `${base}/revisions/${revision.revisionId}/export?format=source`,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("Content-Disposition")).toContain("attachment");
    expect(new Uint8Array(await exported.arrayBuffer()).slice(0, 2)).toEqual(
      new Uint8Array([80, 75]),
    );
  });
});

it("publishes the QA revision without mutating history and replays the outbox once", async () => {
  const { publishCompletedManifests, drainArtifactPublications } =
    await import("../../services/agent-runtime/artifact-integration.js");
  const { publishArtifact } =
    await import("../../services/agent-runtime/artifacts/publisher.js");
  const first = await publish();
  const original = await (
    await agentArtifactRoutes.request(
      `${base}/revisions/${first.revisionId}/bundle`,
    )
  ).json();
  fs.writeFileSync(path.join(root, "demo.html"), "<h1>Denser mini v2</h1>");
  const content =
    "```synax-artifact\n" +
    JSON.stringify({
      sourcePath: "demo.html",
      title: "Runtime card",
      sourceKind: "html",
      artifactId: first.artifactId,
      baseRevisionId: first.revisionId,
    }) +
    "\n```";
  const message = {
    id: "completed-external-message",
    sessionId,
    runId: null,
    stepId: null,
    role: "assistant" as const,
    content,
    createdAt: new Date().toISOString(),
    metadata: { source: "codex" },
  };
  await publishCompletedManifests({ ...message, role: "user" }); // cannot execute user text
  expect(
    (await (await agentArtifactRoutes.request(base)).json()).items[0]
      .revisionNumber,
  ).toBe(1);
  agentRuntimeStore.updateSession(sessionId, {
    permissionRules: [{ gate: "write", pattern: "*", action: "allow" }],
  });
  await publishCompletedManifests(message);
  await publishCompletedManifests(message);
  await vi.waitFor(async () =>
    expect(
      (
        await (
          await agentArtifactRoutes.request(
            `${base}/${first.artifactId}/revisions`,
          )
        ).json()
      ).items,
    ).toHaveLength(2),
  );
  const revisions = (
    await (
      await agentArtifactRoutes.request(`${base}/${first.artifactId}/revisions`)
    ).json()
  ).items;
  expect(revisions).toHaveLength(2);
  expect(
    revisions.map((r: { revisionNumber: number }) => r.revisionNumber).sort(),
  ).toEqual([1, 2]);
  expect(
    (
      await (
        await agentArtifactRoutes.request(
          `${base}/revisions/${first.revisionId}/bundle`,
        )
      ).json()
    ).html,
  ).toBe(original.html);
  const orphan = await publishArtifact(
    { sessionId, projectId: "project-alpha", workspaceRoot: root },
    {
      sourcePath: "demo.html",
      title: "Crash boundary",
      sourceKind: "html",
      idempotencyKey: "direct-ready",
    },
  );
  expect(drainArtifactPublications(sessionId)).toBe(1);
  expect(drainArtifactPublications(sessionId)).toBe(0);
  expect(
    agentRuntimeStore
      .listMessages(sessionId)
      .filter((m) => JSON.stringify(m.metadata).includes(orphan.revisionId)),
  ).toHaveLength(1);
});

it("gates completed manifests with the current publication permission", async () => {
  const { publishCompletedManifests } =
    await import("../../services/agent-runtime/artifact-integration.js");
  const input = {
    sourcePath: "demo.html",
    title: "Needs approval",
    sourceKind: "html",
  };
  const message = {
    id: "external-ask",
    sessionId,
    runId: null,
    stepId: null,
    role: "assistant" as const,
    content: "```synax-artifact\n" + JSON.stringify(input) + "\n```",
    metadata: { source: "codex" },
    createdAt: new Date().toISOString(),
  };
  agentRuntimeStore.updateSession(sessionId, {
    permissionRules: [{ gate: "write", pattern: "*", action: "ask" }],
  });
  await publishCompletedManifests(message);
  expect(
    (await (await agentArtifactRoutes.request(base)).json()).items,
  ).toEqual([]);
  const requestMessage = agentRuntimeStore
    .listMessages(sessionId)
    .find((m) => m.metadata?.source === "artifact_request")!;
  const id = (requestMessage.metadata!.artifactRequest as { requestId: string })
    .requestId;
  expect(
    (await request(base + "/requests/" + id, { action: "approve" })).status,
  ).toBe(403);
  agentRuntimeStore.updateSession(sessionId, {
    permissionRules: [{ gate: "write", pattern: "*", action: "deny" }],
  });
  expect(
    (
      await request(base + "/requests/" + id, { action: "approve" }, "POST", {
        "X-Synax-Artifact-Action": "confirm-publication",
      })
    ).status,
  ).toBe(403);
  agentRuntimeStore.updateSession(sessionId, {
    permissionRules: [{ gate: "write", pattern: "*", action: "ask" }],
  });
  expect(
    (
      await request(base + "/requests/" + id, { action: "approve" }, "POST", {
        "X-Synax-Artifact-Action": "confirm-publication",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect(
      (await (await agentArtifactRoutes.request(base)).json()).items,
    ).toHaveLength(1),
  );
});

it("claims approval atomically so another client cannot reject an in-flight publication", async () => {
  const { requestArtifactPublication, getPublicationRequest } =
    await import("../../services/agent-runtime/artifact-authorization.js");
  const compiler =
    await import("../../services/agent-runtime/artifacts/compiler.js");
  const original = compiler.compileArtifact;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compile = vi
    .spyOn(compiler, "compileArtifact")
    .mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
  const id = requestArtifactPublication(
    sessionId,
    {
      sourcePath: "demo.html",
      title: "Race",
      sourceKind: "html",
      idempotencyKey: "approval-race",
    },
    null,
    null,
  );
  const url = base + "/requests/" + id;
  const headers = { "X-Synax-Artifact-Action": "confirm-publication" };
  const approve = request(url, { action: "approve" }, "POST", headers);
  try {
    await vi.waitFor(() =>
      expect(getPublicationRequest(sessionId, id).status).toBe("publishing"),
    );
    expect(
      (await request(url, { action: "reject" }, "POST", headers)).status,
    ).toBe(409);
  } finally {
    release();
  }
  expect((await approve).status).toBe(202);
  await vi.waitFor(async () => {
    await (
      await import("../../services/agent-runtime/artifact-recovery.js")
    ).recoverArtifacts();
    expect(getPublicationRequest(sessionId, id).status).toBe("ready");
  });
  compile.mockRestore();
});
it('accepts bounded binary screenshots only through the confirmed authenticated host route',async()=>{
 const revision=await publish();const url=`${base}/revisions/${revision.revisionId}/screenshots`;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2m0AAAAASUVORK5CYII=','base64');
 const form=()=>{const body=new FormData();body.append('file',new File([png,Buffer.alloc(70*1024)],'test.png',{type:'image/png'}));return body;};
 expect((await agentArtifactRoutes.request(url,{method:'POST',body:form()})).status).toBe(403);
 const response=await agentArtifactRoutes.request(url,{method:'POST',body:form(),headers:{'X-Synax-Artifact-Action':'capture-screenshot'}});
 expect(response.status).toBe(201);expect((await response.json()).asset.mediaType).toBe('image/png');
});
