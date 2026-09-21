/** Version operations never mutate a published revision or resolve source from live files. */
import { z } from "zod";
import { getRawSqlite } from "../../db/index.js";
import {
  ARTIFACT_LIMITS,
  ArtifactError,
  type ArtifactControl,
  type ArtifactPublishContext,
  type ArtifactRevision,
  type ArtifactState,
} from "./artifacts/contracts.js";
import {
  assertSession,
  beginBuild,
  commitBuild,
  getArtifactBundle,
  getArtifactDependencies,
  getArtifactSource,
  getArtifactState,
  getRevision,
  listRevisions,
  saveArtifactState,
} from "./artifacts/store.js";
import { hash, safeJson } from "./artifacts/validation.js";

export interface ArtifactControlSchema {
  schemaVersion: number;
  controls: ArtifactControl[];
}
export interface ArtifactVersionHistory {
  revisions: ArtifactRevision[];
  derivedFrom: ArtifactRevision | null;
  branches: ArtifactRevision[];
}
export interface ForkArtifactVersionInput {
  title: string;
  idempotencyKey: string;
}
export interface InheritArtifactStateInput {
  sourceRevisionId: string;
  sourceEtag: number;
  expectedEtag: number;
  includePrivateState: boolean;
  includeModelState: boolean;
  confirmSensitiveState: boolean;
}
export interface StateInheritanceInspection {
  compatible: boolean;
  reason: string | null;
  sourceRevisionId: string;
  targetRevisionId: string;
  sourceEtag: number;
  expectedEtag: number;
  controlKeys: string[];
}
function fail(code: string, message: string, status = 409): never {
  throw new ArtifactError(code, message, status);
}
const etag = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const forkArtifactVersionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
export const inheritArtifactStateInputSchema = z
  .object({
    sourceRevisionId: z.string().min(1).max(256),
    sourceEtag: etag,
    expectedEtag: etag,
    includePrivateState: z.boolean().default(false),
    includeModelState: z.boolean().default(false),
    confirmSensitiveState: z.boolean().default(false),
  })
  .strict();
const controlDefinition = z
  .object({
    key: z
      .string()
      .regex(/^[a-zA-Z][\w-]{0,63}$/)
      .refine(
        (key) => !["__proto__", "prototype", "constructor"].includes(key),
      ),
    label: z
      .string()
      .min(1)
      .max(120)
      .refine((label) => !!label.trim()),
    type: z.enum(["select", "toggle", "range", "number", "color", "text"]),
    defaultValue: z.union([
      z.string().max(2000),
      z.number().finite(),
      z.boolean(),
    ]),
    options: z
      .array(
        z
          .object({ label: z.string().max(120), value: z.string().max(2000) })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  })
  .strict();
export const artifactControlSchemaInput = z
  .object({
    schemaVersion: z.number().int().min(1).max(10000),
    controls: z.array(controlDefinition).max(ARTIFACT_LIMITS.controls),
  })
  .strict();

function validValue(control: ArtifactControl, value: unknown): boolean {
  if (control.type === "toggle") return typeof value === "boolean";
  if (control.type === "range" || control.type === "number")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (control.min === undefined || value >= control.min) &&
      (control.max === undefined || value <= control.max)
    );
  if (typeof value !== "string" || value.length > 2000) return false;
  if (control.type === "color") return /^#[\da-f]{6}$/i.test(value);
  return (
    control.type !== "select" ||
    !!control.options?.some((option) => option.value === value)
  );
}
function normalizeSchema(raw: unknown): ArtifactControlSchema {
  // Validate before parsing as well, rejecting prototype-mutating JSON even in unknown fields.
  safeJson(raw, ARTIFACT_LIMITS.stateBytes);
  const schema = artifactControlSchemaInput.parse(raw);
  const keys = new Set<string>();
  for (const control of schema.controls) {
    if (
      keys.has(control.key) ||
      (control.min !== undefined &&
        control.max !== undefined &&
        control.min > control.max) ||
      !validValue(control, control.defaultValue)
    )
      fail(
        "INVALID_SOURCE",
        "Invalid artifact control definition or default.",
        400,
      );
    keys.add(control.key);
    if (
      control.type === "select" &&
      (!control.options ||
        new Set(control.options.map((o) => o.value)).size !==
          control.options.length)
    )
      fail("INVALID_SOURCE", "Invalid artifact control options.", 400);
  }
  // Object member order and display ordering are not a compatibility distinction.
  return {
    schemaVersion: schema.schemaVersion,
    controls: schema.controls
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((c) => ({
        key: c.key,
        label: c.label,
        type: c.type,
        defaultValue: c.defaultValue,
        ...(c.options
          ? {
              options: c.options
                .map((o) => ({ label: o.label, value: o.value }))
                .sort((a, b) => a.value.localeCompare(b.value)),
            }
          : {}),
        ...(c.min !== undefined ? { min: c.min } : {}),
        ...(c.max !== undefined ? { max: c.max } : {}),
        ...(c.step !== undefined ? { step: c.step } : {}),
      })),
  };
}
export function getControlSchema(
  sessionId: string,
  revisionId: string,
): ArtifactControlSchema | null {
  getRevision(sessionId, revisionId);
  const row = getRawSqlite()
    .prepare(
      "SELECT schema_json FROM agent_artifact_control_schemas WHERE session_id=? AND revision_id=?",
    )
    .get(sessionId, revisionId) as { schema_json: string } | undefined;
  return row ? JSON.parse(row.schema_json) : null;
}
/** Called only by the validated host controls hook, not inferred from mutable state values. */
export function registerControlSchema(
  sessionId: string,
  revisionId: string,
  raw: unknown,
): ArtifactControlSchema {
  const schema = normalizeSchema(raw);
  const db = getRawSqlite();
  return db.transaction(() => {
    const old = getControlSchema(sessionId, revisionId);
    if (old && JSON.stringify(old) !== JSON.stringify(schema))
      fail(
        "SCHEMA_CONFLICT",
        "Registered control schema is immutable for this revision. Publish a new revision.",
      );
    const current = getArtifactState(sessionId, revisionId);
    if (current.schemaVersion !== schema.schemaVersion) {
      // A virgin state is absent, not merely empty: a saved/reset state must never
      // be silently relabeled. BEGIN IMMEDIATE + the state CAS fences all writers.
      const persisted = db
        .prepare(
          "SELECT revision_id FROM agent_artifact_state WHERE revision_id=? AND session_id=?",
        )
        .get(revisionId, sessionId);
      if (old || persisted || current.etag !== 0)
        fail(
          "SCHEMA_CONFLICT",
          "Registered schema version does not match saved state. Publish a new revision; saved state cannot be relabeled.",
        );
      saveArtifactState(
        sessionId,
        revisionId,
        {
          schemaVersion: schema.schemaVersion,
          controls: {},
          privateState: null,
          modelState: null,
        },
        0,
      );
    }
    if (!old)
      db.prepare(
        "INSERT INTO agent_artifact_control_schemas(revision_id,session_id,schema_json,created_at) VALUES(?,?,?,?)",
      ).run(
        revisionId,
        sessionId,
        JSON.stringify(schema),
        new Date().toISOString(),
      );
    return schema;
  })();
}

export function getArtifactVersionHistory(
  sessionId: string,
  artifactId: string,
): ArtifactVersionHistory {
  const revisions = listRevisions(sessionId, artifactId);
  const db = getRawSqlite();
  const origin = db
    .prepare(
      `SELECT r.revision_json FROM agent_artifact_lineage l
    JOIN agent_artifact_revisions r ON r.id=l.source_revision_id AND r.session_id=l.session_id
    JOIN agent_artifacts a ON a.id=r.artifact_id AND a.session_id=l.session_id AND a.deleted_at IS NULL
    WHERE l.artifact_id=? AND l.session_id=?`,
    )
    .get(artifactId, sessionId) as { revision_json: string } | undefined;
  const branches = db
    .prepare(
      `SELECT head.revision_json FROM agent_artifact_lineage l
    JOIN agent_artifact_revisions source ON source.id=l.source_revision_id AND source.session_id=l.session_id
    JOIN agent_artifacts a ON a.id=l.artifact_id AND a.session_id=l.session_id AND a.deleted_at IS NULL
    JOIN agent_artifact_revisions head ON head.id=a.head_revision_id AND head.session_id=l.session_id
    WHERE source.artifact_id=? AND l.session_id=? ORDER BY l.created_at,l.artifact_id`,
    )
    .all(artifactId, sessionId) as Array<{ revision_json: string }>;
  return {
    revisions,
    derivedFrom: origin ? JSON.parse(origin.revision_json) : null,
    branches: branches.map((row) => JSON.parse(row.revision_json)),
  };
}

/** Synchronous outer transaction makes fork, receipt, lineage, schema and outbox all-or-nothing. */
export function forkArtifactVersion(
  context: ArtifactPublishContext,
  sourceRevisionId: string,
  raw: ForkArtifactVersionInput,
): ArtifactRevision {
  const input = forkArtifactVersionInputSchema.parse(raw);
  const db = getRawSqlite();
  return db.transaction(() => {
    assertSession(context);
    const source = getRevision(context.sessionId, sourceRevisionId);
    const digest = hash(
      JSON.stringify({ sourceRevisionId, title: input.title }),
    );
    const old = db
      .prepare(
        "SELECT request_hash,first_revision_id FROM agent_artifact_lineage WHERE session_id=? AND idempotency_key=?",
      )
      .get(context.sessionId, input.idempotencyKey) as
      | { request_hash: string; first_revision_id: string }
      | undefined;
    if (old) {
      if (old.request_hash !== digest)
        fail(
          "REVISION_CONFLICT",
          "Idempotency key was already used for a different request.",
        );
      return getRevision(context.sessionId, old.first_revision_id);
    }
    if (context.signal?.aborted)
      fail("BUILD_CANCELLED", "Artifact publication was cancelled.", 499);
    // These readers verify stored integrity and current runtime policy; no source paths are opened.
    const bundle = getArtifactBundle(context.sessionId, sourceRevisionId);
    const files = getArtifactSource(context.sessionId, sourceRevisionId);
    const publishInput = {
      sourcePath: source.sourcePath,
      sourceKind: source.sourceKind,
      title: input.title,
      idempotencyKey: `artifact-fork:${hash(input.idempotencyKey)}`,
    };
    const attempt = beginBuild(context, publishInput);
    // A ready build without a matching lineage receipt is not a valid fork retry.
    if (attempt.revision)
      fail(
        "REVISION_CONFLICT",
        "Fork build key is already in use. Choose a new idempotency key.",
      );
    const revision = commitBuild(context, publishInput, attempt.id, {
      html: bundle.html,
      source: files,
      sourceHash: source.sourceHash,
      bundleHash: source.bundleHash,
      dependencies: getArtifactDependencies(
        context.sessionId,
        sourceRevisionId,
      ),
    });
    db.prepare(
      "INSERT INTO agent_artifact_lineage(artifact_id,session_id,first_revision_id,source_revision_id,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      revision.artifactId,
      context.sessionId,
      revision.revisionId,
      sourceRevisionId,
      input.idempotencyKey,
      digest,
      revision.createdAt,
    );
    const schema = getControlSchema(context.sessionId, sourceRevisionId);
    if (schema)
      registerControlSchema(context.sessionId, revision.revisionId, schema);
    // Deliberately no state copy; even exact forks start with empty state.
    return revision;
  })();
}
function compatibility(
  sessionId: string,
  targetId: string,
  sourceId: string,
): {
  source: ArtifactState;
  target: ArtifactState;
  schema: ArtifactControlSchema;
} {
  const source = getArtifactState(sessionId, sourceId),
    target = getArtifactState(sessionId, targetId);
  if (sourceId === targetId)
    fail("INCOMPATIBLE_STATE", "Choose a different source revision.");
  const sourceSchema = getControlSchema(sessionId, sourceId),
    targetSchema = getControlSchema(sessionId, targetId);
  if (!sourceSchema || !targetSchema)
    fail(
      "INCOMPATIBLE_STATE",
      "Both revisions need registered control schemas. Run each preview first.",
    );
  if (
    source.schemaVersion !== sourceSchema.schemaVersion ||
    target.schemaVersion !== targetSchema.schemaVersion ||
    JSON.stringify(sourceSchema) !== JSON.stringify(targetSchema)
  )
    fail(
      "INCOMPATIBLE_STATE",
      "State schema versions or registered control definitions do not match.",
    );
  for (const [key, value] of Object.entries(source.controls)) {
    const control = sourceSchema.controls.find((c) => c.key === key);
    if (!control || !validValue(control, value))
      fail(
        "INCOMPATIBLE_STATE",
        "Source state contains an invalid or unregistered control value.",
      );
  }
  return { source, target, schema: sourceSchema };
}
/** A review response contains no private/model values (nor their content summaries). */
export function inspectStateInheritance(
  sessionId: string,
  targetId: string,
  sourceId: string,
): StateInheritanceInspection {
  return getRawSqlite().transaction(() => {
    const source = getArtifactState(sessionId, sourceId),
      target = getArtifactState(sessionId, targetId);
    const result: StateInheritanceInspection = {
      compatible: false,
      reason: null,
      sourceRevisionId: sourceId,
      targetRevisionId: targetId,
      sourceEtag: source.etag,
      expectedEtag: target.etag,
      controlKeys: [],
    };
    try {
      const match = compatibility(sessionId, targetId, sourceId);
      result.compatible = true;
      result.controlKeys = match.schema.controls.map((c) => c.key);
    } catch (error) {
      if (
        !(error instanceof ArtifactError) ||
        error.code !== "INCOMPATIBLE_STATE"
      )
        throw error;
      result.reason = error.message;
    }
    return result;
  })();
}
export function inheritArtifactState(
  sessionId: string,
  targetId: string,
  raw: InheritArtifactStateInput,
): ArtifactState {
  const input = inheritArtifactStateInputSchema.parse(raw);
  if (
    (input.includePrivateState || input.includeModelState) &&
    !input.confirmSensitiveState
  )
    fail(
      "CONFIRMATION_REQUIRED",
      "Confirm copying private or model-visible state explicitly.",
      403,
    );
  return getRawSqlite().transaction(() => {
    const { source, target } = compatibility(
      sessionId,
      targetId,
      input.sourceRevisionId,
    );
    if (source.etag !== input.sourceEtag || target.etag !== input.expectedEtag)
      fail(
        "STATE_CONFLICT",
        "Artifact state conflict: review the latest source and target state before inheriting.",
      );
    return saveArtifactState(
      sessionId,
      targetId,
      {
        schemaVersion: target.schemaVersion,
        controls: source.controls,
        privateState: input.includePrivateState
          ? source.privateState
          : target.privateState,
        modelState: input.includeModelState
          ? source.modelState
          : target.modelState,
      },
      input.expectedEtag,
    );
  })();
}
