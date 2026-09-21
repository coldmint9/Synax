import { Hono } from "hono";
import { getRawSqlite } from "../db/index.js";
import { getArtifactState } from "../services/agent-runtime/artifacts/store.js";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ArtifactError } from "../services/agent-runtime/artifacts/contracts.js";
import { agentRuntimeStore } from "../services/agent-runtime/session-store.js";
import { drainArtifactPublications } from "../services/agent-runtime/artifact-integration.js";
import { toHttpError } from "../services/agent-runtime/runtime-errors.js";
import {
  forkArtifactVersion,
  forkArtifactVersionInputSchema,
  getArtifactVersionHistory,
  getControlSchema,
  inheritArtifactState,
  inheritArtifactStateInputSchema,
  inspectStateInheritance,
  registerControlSchema,
} from "../services/agent-runtime/artifact-versions.js";

/** Mount alongside agentArtifactRoutes, at the same /api/agent-runtime prefix. */
export const artifactVersionRoutes = new Hono();
const base = "/sessions/:sessionId/artifacts";
const revision = `${base}/revisions/:revisionId`;
// Constrain middleware to owned endpoints: sibling screenshot/upload routes may
// allow larger bodies and must not inherit this module's 32 KiB limit.
for (const endpoint of [
  `${base}/:artifactId/versions`,
  `${revision}/control-schema`,
  `${revision}/fork`,
  `${revision}/inheritance`,
  `${revision}/inherit-state`,
]) {
  artifactVersionRoutes.use(
    endpoint,
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) =>
        c.json(
          {
            error: "Artifact version request too large.",
            code: "RESOURCE_LIMIT",
          },
          413,
        ),
    }),
  );
  artifactVersionRoutes.use(endpoint, async (c, next) => {
    agentRuntimeStore.getSession(c.req.param("sessionId")!);
    c.header("Cache-Control", "no-store");
    await next();
  });
}
artifactVersionRoutes.onError((error, c) => {
  if (error instanceof ArtifactError)
    return c.json(
      { error: error.message, code: error.code },
      error.status as 400 | 403 | 404 | 409 | 413 | 500,
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json(
      { error: "Invalid artifact version request.", code: "INVALID_SOURCE" },
      400,
    );
  const mapped = toHttpError(error);
  return c.json(mapped.body, mapped.status as 400 | 403 | 404 | 409 | 500);
});
function requireAction(actual: string | undefined, expected: string): void {
  if (actual !== expected)
    throw new ArtifactError(
      "CONFIRMATION_REQUIRED",
      "This action must be confirmed in the host.",
      403,
    );
}
artifactVersionRoutes.get(`${base}/:artifactId/versions`, (c) =>
  c.json(
    getArtifactVersionHistory(
      c.req.param("sessionId")!,
      c.req.param("artifactId")!,
    ),
  ),
);
artifactVersionRoutes.get(`${revision}/control-schema`, (c) =>
  c.json({
    schema: getControlSchema(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
    ),
  }),
);
artifactVersionRoutes.put(`${revision}/control-schema`, async (c) => {
  requireAction(
    c.req.header("X-Synax-Artifact-Action"),
    "register-control-schema",
  );
  const input = await c.req.json();
  const sessionId = c.req.param("sessionId")!;
  const revisionId = c.req.param("revisionId")!;
  return c.json(
    getRawSqlite().transaction(() => ({
      schema: registerControlSchema(sessionId, revisionId, input),
      state: getArtifactState(sessionId, revisionId),
    }))(),
  );
});
artifactVersionRoutes.post(`${revision}/fork`, async (c) => {
  requireAction(c.req.header("X-Synax-Artifact-Action"), "confirm-fork");
  const input = forkArtifactVersionInputSchema.parse(await c.req.json());
  const sessionId = c.req.param("sessionId")!;
  // Only the server-resolved session determines project identity. This operation deliberately
  // needs no workspace resolver: even a deleted workspace can branch its immutable snapshots.
  const session = agentRuntimeStore.getSession(sessionId);
  const published = forkArtifactVersion(
    { sessionId, projectId: session.projectId, workspaceRoot: "" },
    c.req.param("revisionId")!,
    input,
  );
  drainArtifactPublications(sessionId);
  return c.json({ revision: published }, 201);
});
artifactVersionRoutes.get(`${revision}/inheritance`, (c) => {
  const sourceId = z
    .string()
    .min(1)
    .max(256)
    .parse(c.req.query("sourceRevisionId"));
  return c.json(
    inspectStateInheritance(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
      sourceId,
    ),
  );
});
artifactVersionRoutes.post(`${revision}/inherit-state`, async (c) => {
  requireAction(
    c.req.header("X-Synax-Artifact-Action"),
    "confirm-inherit-state",
  );
  const input = inheritArtifactStateInputSchema.parse(await c.req.json());
  return c.json(
    inheritArtifactState(
      c.req.param("sessionId")!,
      c.req.param("revisionId")!,
      input,
    ),
  );
});
