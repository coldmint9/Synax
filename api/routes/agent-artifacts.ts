import { getRawSqlite } from "../db/index.js";
import { runtimeTransaction } from "../services/agent-runtime/runtime-transaction.js";
import {
  enqueueArtifactJob,
  getArtifactJob,
  listArtifactJobs,
  cancelArtifactJob,
  retryArtifactJob,
} from "../services/agent-runtime/artifact-jobs.js";
import { bodyLimit } from "hono/body-limit";
import {
  publicationPermission,
  getPublicationRequest,
  resolvePublicationRequest,
} from "../services/agent-runtime/artifact-authorization.js";
import { Hono } from "hono";
import { z } from "zod";
import { agentRuntimeStore } from "../services/agent-runtime/session-store.js";
import { publishArtifactSchema } from "../services/agent-runtime/artifact-manifest.js";
import { publishSessionArtifact } from "../services/agent-runtime/artifact-integration.js";
import {
  listArtifacts,
  listArtifactBuilds,
  listRevisions,
  getArtifactBundle,
  getArtifactSource,
  getArtifactState,
  saveArtifactState,
  deleteArtifact,
} from "../services/agent-runtime/artifacts/publisher.js";
import { exportArtifact } from "../services/agent-runtime/artifacts/export.js";
import {
  submitArtifactFeedback,
  uploadArtifactScreenshot,
  MAX_ARTIFACT_SCREENSHOT_BYTES,
} from "../services/agent-runtime/artifact-feedback.js";
import { ArtifactError } from "../services/agent-runtime/artifacts/contracts.js";
import { toHttpError } from "../services/agent-runtime/runtime-errors.js";

export const agentArtifactRoutes = new Hono();
agentArtifactRoutes.use("/sessions/:sessionId/artifacts/*", async (c, next) => {
  if (c.req.path.endsWith("/screenshots"))
    return bodyLimit({ maxSize: 4 * 1024 * 1024 + 65536 })(c, next);
  return bodyLimit({ maxSize: 64 * 1024 })(c, next);
});
agentArtifactRoutes.use(
  "/sessions/:sessionId/artifacts",
  bodyLimit({ maxSize: 64 * 1024 }),
);
agentArtifactRoutes.use("/sessions/:sessionId/artifacts/*", async (c, next) => {
  try {
    agentRuntimeStore.getSession(c.req.param("sessionId")!);
    await next();
  } catch (error) {
    if (error instanceof ArtifactError)
      return c.json(
        { error: error.message, code: error.code },
        error.status as 400 | 404 | 409 | 413 | 500,
      );
    if (error instanceof z.ZodError)
      return c.json(
        { error: "Invalid artifact request", code: "INVALID_SOURCE" },
        400,
      );
    const mapped = toHttpError(error);
    return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
  }
});
agentArtifactRoutes.onError((error, c) => {
  if (error instanceof ArtifactError)
    return c.json(
      { error: error.message, code: error.code },
      error.status as 400 | 404 | 409 | 413 | 500,
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json(
      { error: "Invalid artifact request", code: "INVALID_SOURCE" },
      400,
    );
  const mapped = toHttpError(error);
  return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
});
const base = "/sessions/:sessionId/artifacts";
agentArtifactRoutes.get(base, (c) => {
  const id = c.req.param("sessionId")!;
  agentRuntimeStore.getSession(id);
  return c.json({ items: listArtifacts(id) });
});
agentArtifactRoutes.post(base, async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 8192)
    throw new ArtifactError("RESOURCE_LIMIT", "Publish request too large", 413);
  const input = publishArtifactSchema.parse(JSON.parse(raw));
  const job = enqueueArtifactJob(c.req.param("sessionId")!, input);
  return c.json({ job }, 202);
});
agentArtifactRoutes.get(base + "/:artifactId/revisions", (c) =>
  c.json({
    items: listRevisions(c.req.param("sessionId")!, c.req.param("artifactId")!),
  }),
);
agentArtifactRoutes.get(base + "/revisions/:revisionId/bundle", (c) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  return c.json(
    getArtifactBundle(c.req.param("sessionId")!, c.req.param("revisionId")!),
  );
});
agentArtifactRoutes.get(base + "/revisions/:revisionId/source", (c) =>
  c.json({
    files: getArtifactSource(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
    ),
  }),
);
agentArtifactRoutes.get(base + "/revisions/:revisionId/state", (c) =>
  c.json(
    getArtifactState(c.req.param("sessionId")!, c.req.param("revisionId")!),
  ),
);
agentArtifactRoutes.put(base + "/revisions/:revisionId/state", async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 18000)
    throw new ArtifactError("RESOURCE_LIMIT", "State exceeds 16 KiB", 413);
  const data = z
    .object({
      privateState: z.unknown(),
      modelState: z.unknown(),
      controls: z.record(z.string(), z.unknown()),
      schemaVersion: z.number().int().min(1),
      expectedEtag: z.number().int().min(0),
    })
    .strict()
    .parse(JSON.parse(raw));
  const { expectedEtag, ...state } = data;
  return c.json(
    saveArtifactState(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
      state,
      expectedEtag,
    ),
  );
});
agentArtifactRoutes.post(
  base + "/revisions/:revisionId/feedback",
  async (c) => {
    if (c.req.header("X-Synax-Artifact-Action") !== "confirm-feedback")
      return c.json(
        {
          error: "Feedback must be confirmed in the host",
          code: "CONFIRMATION_REQUIRED",
        },
        403,
      );
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 32768)
      throw new ArtifactError("RESOURCE_LIMIT", "Feedback exceeds 32 KiB", 413);
    const result = submitArtifactFeedback(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
      JSON.parse(raw),
    );
    const { runCoordinator } =
      await import("../services/agent-runtime/run-coordinator.js");
    runCoordinator.dispatchQueuedInput(c.req.param("sessionId")!);
    return c.json(result);
  },
);
agentArtifactRoutes.get(base + "/revisions/:revisionId/export", async (c) => {
  const format = z
    .enum(["html", "source"])
    .parse(c.req.query("format") ?? "html");
  const output = await exportArtifact(
    c.req.param("sessionId")!,
    c.req.param("revisionId")!,
    format,
  );
  c.header("Content-Type", output.mediaType);
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Disposition",
    `attachment; filename="${output.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
  );
  return c.body(output.content as string);
});
agentArtifactRoutes.delete(base + "/:artifactId", (c) => {
  deleteArtifact(c.req.param("sessionId")!, c.req.param("artifactId")!);
  return c.json({ deleted: true });
});

agentArtifactRoutes.get(base + "/requests/:requestId", (c) =>
  c.json(
    getPublicationRequest(c.req.param("sessionId")!, c.req.param("requestId")!),
  ),
);
agentArtifactRoutes.post(base + "/requests/:requestId", async (c) => {
  if (c.req.header("X-Synax-Artifact-Action") !== "confirm-publication")
    return c.json(
      {
        error: "Explicit host approval is required",
        code: "CONFIRMATION_REQUIRED",
      },
      403,
    );
  const sessionId = c.req.param("sessionId")!;
  const id = c.req.param("requestId")!;
  const request = getPublicationRequest(sessionId, id);
  const { action } = z
    .object({ action: z.enum(["approve", "reject"]) })
    .strict()
    .parse(await c.req.json());
  if (request.status === "publishing")
    throw new ArtifactError(
      "REVISION_CONFLICT",
      "Publication is already approved and building",
      409,
    );
  if (request.status !== "pending")
    return c.json({ status: request.status, revisionId: request.revisionId });
  if (action === "reject") {
    resolvePublicationRequest(sessionId, id, "rejected");
    return c.json({ status: "rejected" });
  }
  if (publicationPermission(sessionId, request.input).action === "deny")
    throw new ArtifactError(
      "PERMISSION_DENIED",
      "Publication is denied by the current session policy",
      403,
    );
  const job = runtimeTransaction(() => {
    resolvePublicationRequest(sessionId, id, "publishing");
    let job = enqueueArtifactJob(
      sessionId,
      request.input,
      request.runId,
      request.stepId,
    );
    if (job.status === "failed" || job.status === "cancelled")
      job = retryArtifactJob(sessionId, job.jobId);
    getRawSqlite()
      .prepare(
        "UPDATE artifact_publication_requests SET job_id=? WHERE id=? AND session_id=? AND status='publishing'",
      )
      .run(job.jobId, id, sessionId);
    return job;
  });
  return c.json({ status: "publishing", jobId: job.jobId, job }, 202);
});

agentArtifactRoutes.get(base + "/builds", (c) =>
  c.json({
    items: listArtifactBuilds(
      c.req.param("sessionId")!,
      c.req.query("artifactId"),
    ),
  }),
);

agentArtifactRoutes.get(base + "/jobs", (c) =>
  c.json({ items: listArtifactJobs(c.req.param("sessionId")!) }),
);
agentArtifactRoutes.get(base + "/jobs/:jobId", (c) =>
  c.json({
    job: getArtifactJob(c.req.param("sessionId")!, c.req.param("jobId")!),
  }),
);
agentArtifactRoutes.post(base + "/jobs/:jobId/cancel", (c) =>
  c.json({
    job: cancelArtifactJob(c.req.param("sessionId")!, c.req.param("jobId")!),
  }),
);
agentArtifactRoutes.post(base + "/jobs/:jobId/retry", (c) =>
  c.json({
    job: retryArtifactJob(c.req.param("sessionId")!, c.req.param("jobId")!),
  }),
);

agentArtifactRoutes.post(
  base + "/revisions/:revisionId/screenshots",
  async (c) => {
    if (c.req.header("X-Synax-Artifact-Action") !== "capture-screenshot")
      throw new ArtifactError(
        "CONFIRMATION_REQUIRED",
        "Screenshot must be confirmed in the host",
        403,
      );
    const form = await c.req.formData();
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.type !== "image/png" ||
      file.size > MAX_ARTIFACT_SCREENSHOT_BYTES
    )
      throw new ArtifactError(
        "INVALID_SOURCE",
        "Only bounded PNG screenshots are accepted",
        400,
      );
    const asset = await uploadArtifactScreenshot(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
      Buffer.from(await file.arrayBuffer()),
    );
    return c.json({ asset }, 201);
  },
);
