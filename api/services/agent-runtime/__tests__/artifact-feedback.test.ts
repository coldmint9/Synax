import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  submitArtifactFeedback,
  uploadArtifactScreenshot,
  artifactFeedbackSchema,
} from "../artifact-feedback.js";
import { publishArtifact } from "../artifacts/publisher.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { inputQueueService } from "../input-queue-service.js";
import {
  bindAssets,
  createAsset,
  modelContentParts,
  readAsset,
  sessionHasAsset,
} from "../media-assets.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
vi.mock("../run-coordinator.js", () => ({
  runCoordinator: { dispatchQueuedInput: vi.fn() },
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
  "base64",
);
let root: string,
  session: ReturnType<typeof agentSessionRuntime.create>,
  revisionId: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-feedback-"));
  fs.writeFileSync(path.join(root, "demo.html"), "<p>Screenshot test</p>");
  session = agentSessionRuntime.create(executorInput);
  revisionId = (
    await publishArtifact(
      {
        sessionId: session.id,
        projectId: session.projectId,
        workspaceRoot: root,
      },
      {
        sourcePath: "demo.html",
        sourceKind: "html",
        title: "Test",
        idempotencyKey: "publish",
      },
    )
  ).revisionId;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const feedback = (assetId: string) => ({
  text: "Fix this area",
  idempotencyKey: "feedback",
  screenshots: [{ assetId, previewConfirmed: true }],
});
describe("artifact screenshot feedback", () => {
  it("uploads real bytes, binds session, queues model-readable image parts without base64 JSON, and deduplicates", async () => {
    const asset = await uploadArtifactScreenshot(session.id, revisionId, png);
    expect(sessionHasAsset(session.id, asset.id)).toBe(true);
    expect(await readAsset(asset.id, session.projectId)).toEqual(png);
    const first = submitArtifactFeedback(
      session.id,
      revisionId,
      feedback(asset.id),
    );
    expect(
      submitArtifactFeedback(session.id, revisionId, feedback(asset.id)),
    ).toEqual(first);
    const queue = inputQueueService.list(session.id);
    expect(queue).toHaveLength(1);
    expect(queue[0].contentParts).toEqual([
      { type: "text", text: first.message },
      { type: "image", assetId: asset.id },
    ]);
    expect(JSON.stringify(queue)).not.toContain(png.toString("base64"));
    const model = modelContentParts(queue[0].contentParts!);
    expect(model).toContainEqual(
      expect.objectContaining({
        type: "file",
        mediaType: "image/png",
        data: new URL(`synax-asset:${asset.id}`),
      }),
    );
  });
  it("rejects same-project assets not already bound to this session and cross-project assets", async () => {
    const asset = await createAsset(
      session.projectId,
      "unbound.png",
      png,
      "image/png",
    );
    expect(() =>
      submitArtifactFeedback(session.id, revisionId, feedback(asset.id)),
    ).toThrow("this session");
    const other = agentSessionRuntime.create(executorInput);
    bindAssets(other.id, [{ type: "image", assetId: asset.id }]);
    expect(() =>
      submitArtifactFeedback(session.id, revisionId, feedback(asset.id)),
    ).toThrow("this session");
    const foreign = await createAsset(
      "other-project",
      "foreign.png",
      png,
      "image/png",
    );
    expect(() =>
      submitArtifactFeedback(session.id, revisionId, feedback(foreign.id)),
    ).toThrow("different project");
    expect(inputQueueService.list(session.id)).toHaveLength(0);
  });
  it("rejects missing preview confirmation, inline screenshot data and unsafe annotation bounds", () => {
    const id = "asset_" + "a".repeat(32);
    expect(
      artifactFeedbackSchema.safeParse({
        ...feedback(id),
        screenshots: [{ assetId: id }],
      }).success,
    ).toBe(false);
    expect(
      artifactFeedbackSchema.safeParse({
        ...feedback(id),
        screenshots: [{ assetId: id, previewConfirmed: false }],
      }).success,
    ).toBe(false);
    expect(
      artifactFeedbackSchema.safeParse({
        ...feedback(id),
        screenshots: [
          { assetId: id, previewConfirmed: true, data: png.toString("base64") },
        ],
      }).success,
    ).toBe(false);
    expect(
      artifactFeedbackSchema.safeParse({
        ...feedback(id),
        element: {
          tag: "button",
          text: "Fix",
          bounds: {
            x: 90,
            y: 0,
            width: 20,
            height: 10,
            viewportWidth: 100,
            viewportHeight: 100,
          },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects cross-session revision upload, non-PNG, excessive byte size and image dimensions", async () => {
    const other = agentSessionRuntime.create(executorInput);
    await expect(
      uploadArtifactScreenshot(other.id, revisionId, png),
    ).rejects.toThrow();
    await expect(
      uploadArtifactScreenshot(
        session.id,
        revisionId,
        Buffer.from("not an image"),
      ),
    ).rejects.toThrow("PNG");
    await expect(
      uploadArtifactScreenshot(
        session.id,
        revisionId,
        Buffer.alloc(4 * 1024 * 1024 + 1),
      ),
    ).rejects.toThrow("4 MiB");
    const large = Buffer.from(png);
    large.writeUInt32BE(4097, 16);
    await expect(
      uploadArtifactScreenshot(session.id, revisionId, large),
    ).rejects.toThrow("4096");
  });
});
