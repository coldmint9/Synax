import { bindVersionAssets } from "../checkpoints/version-runtime/assets.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { clearVersionSessionFixture } from "./version-session-fixture.js";
import {
  initializeVersionNative,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import {
  createAsset,
  bindAssets,
  sessionHasAsset,
  deleteUnboundAsset,
  readAsset,
  sweepAssets,
} from "../media-assets.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { applyHistory } from "../checkpoints/operations.js";
import { VersionCollector } from "../checkpoints/version-store/gc.js";
import { VersionResources } from "../checkpoints/version-store/resources.js";
import { getRawSqlite } from "../../../db/index.js";
let id: string;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
beforeEach(() => {
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: process.cwd(),
  });
  id = session.id;
  store.updateSession(id, { status: "completed" });
  initializeVersionNative(
    store.getSession(id),
    store.listEvents(id),
    session.contextSnapshotId
      ? store.getContextBundle(session.contextSnapshotId)
      : undefined,
  );
});
afterEach(() => clearVersionSessionFixture(id));
async function checkpoint(key: string) {
  store.appendMessage({
    id: key,
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: key,
    metadata: {},
    createdAt: "now",
  });
  return (await captureCheckpoint(id, "reply", key))!;
}
function collect() {
  const gc = new VersionCollector(versionRepository().objects);
  for (let n = 0; n < 1000; n++) {
    if (!gc.collect({ maxMs: 1000 }).remaining) return;
  }
  throw new Error("GC did not finish");
}
it("binds Native message attachments without copying binary payloads or legacy binding rows", async () => {
  const asset = await createAsset(
    plannerSessionInput.projectId,
    "picture.png",
    png,
    "image/png",
  );
  store.appendMessage({
    id: "image-message",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "",
    contentParts: [{ type: "image", assetId: asset.id }],
    metadata: {},
    createdAt: "now",
  });
  expect(sessionHasAsset(id, asset.id)).toBe(true);
  expect(store.getMessage(id, "image-message")?.contentParts).toEqual([
    { type: "image", assetId: asset.id },
  ]);
  expect(
    getRawSqlite()
      .prepare(
        "SELECT count(*) AS n FROM agent_runtime_asset_sessions WHERE session_id=?",
      )
      .get(id),
  ).toMatchObject({ n: 0 });
  expect(
    await createAsset(
      plannerSessionInput.projectId,
      "picture.png",
      png,
      "image/png",
    ),
  ).toMatchObject({ id: asset.id });
});
it("keeps checkpoint assets but hides and eventually reclaims attachments from a popped branch", async () => {
  const first = await createAsset(
    plannerSessionInput.projectId,
    "first.png",
    png,
    "image/png",
  );
  bindAssets(id, [{ type: "image", assetId: first.id }]);
  const cp = await checkpoint("before");
  const future = await createAsset(
    plannerSessionInput.projectId,
    "future.png",
    png,
    "image/png",
  );
  bindAssets(id, [{ type: "image", assetId: future.id }]);
  await applyHistory(id, {
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo-assets",
    action: "rollback",
    includeFiles: false,
  });
  expect(sessionHasAsset(id, first.id)).toBe(true);
  expect(sessionHasAsset(id, future.id)).toBe(false);
  collect();
  await expect(deleteUnboundAsset(first.id)).rejects.toThrow(/retained|use/i);
  await deleteUnboundAsset(future.id);
  await expect(readAsset(future.id)).rejects.toThrow();
  expect(await readAsset(first.id)).toEqual(png);
});
it("does not delete assets retained only by an older checkpoint", async () => {
  const asset = await createAsset(
    plannerSessionInput.projectId,
    "checkpoint-only.png",
    png,
    "image/png",
  );
  bindAssets(id, [{ type: "image", assetId: asset.id }]);
  await checkpoint("retain");
  versionRepository().remove(id, "assets", asset.id);
  expect(sessionHasAsset(id, asset.id)).toBe(false);
  collect();
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_assets SET created_at='2000-01-01' WHERE id=?",
    )
    .run(asset.id);
  await sweepAssets();
  expect(await readAsset(asset.id)).toEqual(png);
});
it("rejects foreign-project bindings and rolls back publication on ref-quota failure", async () => {
  const other = await createAsset(
    "other-project",
    "other.png",
    png,
    "image/png",
  );
  expect(() =>
    bindAssets(id, [{ type: "image", assetId: other.id }]),
  ).toThrow();
  const asset = await createAsset(
      plannerSessionInput.projectId,
      "quota.png",
      png,
      "image/png",
    ),
    repo = versionRepository(),
    before = repo.head(id),
    resources = new VersionResources(getRawSqlite()),
    limit = resources.metadata().limit;
  resources.setMetadataLimit(resources.metadata().bytes);
  try {
    expect(() =>
      bindAssets(id, [{ type: "image", assetId: asset.id }]),
    ).toThrow(/budget/i);
    expect(repo.head(id)).toEqual(before);
    expect(sessionHasAsset(id, asset.id)).toBe(false);
  } finally {
    resources.setMetadataLimit(limit);
  }
});

it("keeps media referenced by a live message even when its active tool binding is removed", async () => {
  const asset = await createAsset(
    plannerSessionInput.projectId,
    "message-root.png",
    png,
    "image/png",
  );
  store.appendMessage({
    id: "kept-image",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "",
    contentParts: [{ type: "image", assetId: asset.id }],
    metadata: {},
    createdAt: "now",
  });
  versionRepository().remove(id, "assets", asset.id);
  collect();
  await expect(deleteUnboundAsset(asset.id)).rejects.toThrow(/retained|use/i);
  expect(await readAsset(asset.id)).toEqual(png);
  versionRepository().remove(id, "messages", "kept-image");
  collect();
  await deleteUnboundAsset(asset.id);
});

it("rechecks actual project ownership inside the version publication transaction", async () => {
  const foreign = await createAsset(
      "foreign-project",
      "foreign.png",
      png,
      "image/png",
    ),
    before = versionRepository().head(id);
  expect(() =>
    bindVersionAssets(id, [
      { ...foreign, projectId: plannerSessionInput.projectId },
    ]),
  ).toThrow(/project|missing/i);
  expect(versionRepository().head(id)).toEqual(before);
  expect(sessionHasAsset(id, foreign.id)).toBe(false);
});

it("checks current project authority as well as branch membership on asset access", async () => {
  const asset = await createAsset(
    plannerSessionInput.projectId,
    "authority.png",
    png,
    "image/png",
  );
  bindAssets(id, [{ type: "image", assetId: asset.id }]);
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_sessions SET project_id='different-project' WHERE id=?",
    )
    .run(id);
  expect(sessionHasAsset(id, asset.id)).toBe(false);
});
