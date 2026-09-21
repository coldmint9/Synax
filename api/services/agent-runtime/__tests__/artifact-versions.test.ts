import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ArtifactControl,
  ArtifactRevision,
} from "../artifacts/contracts.js";

let root: string;
let db: typeof import("../../../db/index.js");
let pub: typeof import("../artifacts/publisher.js");
let versions: typeof import("../artifact-versions.js");
const context = () => ({
  sessionId: "s1",
  projectId: "p1",
  workspaceRoot: root,
});
const input = (key: string) => ({
  sourcePath: "index.html",
  title: "Demo",
  sourceKind: "html" as const,
  idempotencyKey: key,
});
const controls: ArtifactControl[] = [
  {
    key: "size",
    label: "Size",
    type: "range",
    min: 1,
    max: 10,
    defaultValue: 2,
  },
];
const schema = { schemaVersion: 1, controls };
let one: ArtifactRevision, two: ArtifactRevision;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-versions-"));
  process.env.DATA_ROOT = path.join(root, "data");
  process.env.LOG_LEVEL = "silent";
  vi.resetModules();
  db = await import("../../../db/index.js");
  for (const id of ["s1", "s2"])
    db.getRawSqlite()
      .prepare(
        `INSERT INTO agent_runtime_sessions(id,project_id,profile_id,status,prompt,thinking_mode,created_at,updated_at) VALUES(?,'p1','default','idle','','normal','now','now')`,
      )
      .run(id);
  pub = await import("../artifacts/publisher.js");
  versions = await import("../artifact-versions.js");
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Historical</h1>");
  one = await pub.publishArtifact(context(), input("one"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Current</h1>");
  two = await pub.publishArtifact(context(), {
    ...input("two"),
    artifactId: one.artifactId,
    baseRevisionId: one.revisionId,
  });
});
afterEach(() => {
  db?.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  delete process.env.LOG_LEVEL;
});
function register() {
  versions.registerControlSchema("s1", one.revisionId, schema);
  versions.registerControlSchema("s1", two.revisionId, schema);
  pub.saveArtifactState(
    "s1",
    one.revisionId,
    {
      schemaVersion: 1,
      controls: { size: 7 },
      privateState: { secret: "private" },
      modelState: { page: "model" },
    },
    0,
  );
}
const inherit = (extra = {}) =>
  versions.inheritArtifactState("s1", two.revisionId, {
    sourceRevisionId: one.revisionId,
    sourceEtag: 1,
    expectedEtag: 0,
    includePrivateState: false,
    includeModelState: false,
    confirmSensitiveState: false,
    ...extra,
  });

it("publishes a historical immutable snapshot as a new branch without reading live files or moving the original head", () => {
  fs.unlinkSync(path.join(root, "index.html"));
  const fork = versions.forkArtifactVersion(context(), one.revisionId, {
    title: "Branch",
    idempotencyKey: "fork",
  });
  expect(fork.artifactId).not.toBe(one.artifactId);
  expect(fork.revisionNumber).toBe(1);
  expect(pub.getArtifactSource("s1", fork.revisionId)).toEqual(
    pub.getArtifactSource("s1", one.revisionId),
  );
  expect(pub.getArtifactBundle("s1", fork.revisionId).html).toContain(
    "Historical",
  );
  expect(pub.listRevisions("s1", one.artifactId)).toEqual([two, one]);
  expect(
    versions.getArtifactVersionHistory("s1", fork.artifactId).derivedFrom,
  ).toMatchObject({ artifactId: one.artifactId, revisionId: one.revisionId });
  expect(
    versions.getArtifactVersionHistory("s1", one.artifactId).branches,
  ).toEqual([expect.objectContaining({ artifactId: fork.artifactId })]);
  expect(pub.pendingArtifactEvents("s1")).toHaveLength(3);
  expect(
    versions.forkArtifactVersion(context(), one.revisionId, {
      title: "Branch",
      idempotencyKey: "fork",
    }),
  ).toEqual(fork);
  expect(() =>
    versions.forkArtifactVersion(context(), two.revisionId, {
      title: "Branch",
      idempotencyKey: "fork",
    }),
  ).toThrow(/different request/i);
  expect(pub.getArtifactState("s1", fork.revisionId).etag).toBe(0);
});
it("requires matching durable schemas and opt-in inheritance; never copies private or model state by default", () => {
  expect(() => inherit({ sourceEtag: 0 })).toThrow(/registered/i);
  register();
  const preview = versions.inspectStateInheritance(
    "s1",
    two.revisionId,
    one.revisionId,
  );
  expect(preview).toMatchObject({
    compatible: true,
    sourceEtag: 1,
    expectedEtag: 0,
  });
  expect(JSON.stringify(preview)).not.toMatch(/private|model/);
  expect(inherit()).toEqual({
    schemaVersion: 1,
    etag: 1,
    controls: { size: 7 },
    privateState: null,
    modelState: null,
  });
  expect(() => inherit()).toThrow(/conflict/i);
});
it("requires a separate explicit confirmation for sensitive state and protects both source and target CAS", () => {
  register();
  expect(() => inherit({ includePrivateState: true })).toThrow(/confirm/i);
  expect(() => inherit({ includeModelState: true })).toThrow(/confirm/i);
  expect(() => inherit({ sourceEtag: 0 })).toThrow(/conflict/i);
  expect(() => inherit({ expectedEtag: 3 })).toThrow(/conflict/i);
  expect(
    inherit({
      includePrivateState: true,
      includeModelState: true,
      confirmSensitiveState: true,
    }),
  ).toMatchObject({
    privateState: { secret: "private" },
    modelState: { page: "model" },
  });
});
it("rejects incompatible definitions, unregistered keys, invalid values and mismatched saved schema version", () => {
  register();
  expect(() =>
    versions.registerControlSchema("s1", two.revisionId, {
      schemaVersion: 1,
      controls: [{ ...controls[0], max: 20 }],
    }),
  ).toThrow(/immutable/i);
  pub.saveArtifactState(
    "s1",
    one.revisionId,
    {
      schemaVersion: 1,
      controls: { size: 100 },
      privateState: null,
      modelState: null,
    },
    1,
  );
  expect(() => inherit({ sourceEtag: 2 })).toThrow(/control/i);
  pub.saveArtifactState(
    "s1",
    one.revisionId,
    {
      schemaVersion: 2,
      controls: { size: 2 },
      privateState: null,
      modelState: null,
    },
    2,
  );
  expect(() => inherit({ sourceEtag: 3 })).toThrow(/schema/i);
});
it("enforces session/project scoping and deletion without exposing lineage", () => {
  expect(() =>
    versions.forkArtifactVersion(
      { ...context(), sessionId: "s2" },
      one.revisionId,
      { title: "X", idempotencyKey: "x" },
    ),
  ).toThrow(/not found/i);
  expect(() =>
    versions.forkArtifactVersion(
      { ...context(), projectId: "wrong" },
      one.revisionId,
      { title: "X", idempotencyKey: "x" },
    ),
  ).toThrow(/not found/i);
  expect(() =>
    versions.getArtifactVersionHistory("s2", one.artifactId),
  ).toThrow(/not found/i);
  expect(() =>
    versions.registerControlSchema("s2", one.revisionId, schema),
  ).toThrow(/not found/i);
  expect(() =>
    versions.inspectStateInheritance("s2", two.revisionId, one.revisionId),
  ).toThrow(/not found/i);
  const fork = versions.forkArtifactVersion(context(), one.revisionId, {
    title: "Branch",
    idempotencyKey: "fork",
  });
  pub.deleteArtifact("s1", one.artifactId);
  expect(
    versions.getArtifactVersionHistory("s1", fork.artifactId).derivedFrom,
  ).toBeNull();
  expect(() =>
    versions.forkArtifactVersion(context(), one.revisionId, {
      title: "Branch",
      idempotencyKey: "fork",
    }),
  ).toThrow(/not found/i);
});
it("keeps schema and lineage through session INSERT OR REPLACE and database reopen", async () => {
  register();
  const fork = versions.forkArtifactVersion(context(), one.revisionId, {
    title: "Branch",
    idempotencyKey: "fork",
  });
  db.getRawSqlite()
    .prepare(
      `INSERT OR REPLACE INTO agent_runtime_sessions(id,project_id,profile_id,status,prompt,thinking_mode,created_at,updated_at) VALUES('s1','p1','default','idle','','normal','now','now')`,
    )
    .run();
  db.closeDb();
  expect(
    versions.getArtifactVersionHistory("s1", fork.artifactId).derivedFrom
      ?.revisionId,
  ).toBe(one.revisionId);
  expect(versions.getControlSchema("s1", fork.revisionId)).toEqual(schema);
  expect(inherit().controls).toEqual({ size: 7 });
});

it("compares actual registered definitions, not just schemaVersion, and rejects unknown controls", () => {
  versions.registerControlSchema("s1", one.revisionId, schema);
  versions.registerControlSchema("s1", two.revisionId, {
    schemaVersion: 1,
    controls: [{ ...controls[0], max: 20 }],
  });
  expect(
    versions.inspectStateInheritance("s1", two.revisionId, one.revisionId),
  ).toMatchObject({ compatible: false });
  expect(() => inherit({ sourceEtag: 0 })).toThrow(/definitions/i);
  const fork = versions.forkArtifactVersion(context(), one.revisionId, {
    title: "Branch",
    idempotencyKey: "fork",
  });
  pub.saveArtifactState(
    "s1",
    one.revisionId,
    {
      schemaVersion: 1,
      controls: { unknown: 3 },
      privateState: null,
      modelState: null,
    },
    0,
  );
  expect(() =>
    versions.inheritArtifactState("s1", fork.revisionId, {
      sourceRevisionId: one.revisionId,
      sourceEtag: 1,
      expectedEtag: 0,
      includePrivateState: false,
      includeModelState: false,
      confirmSensitiveState: false,
    }),
  ).toThrow(/unregistered/i);
});
it("allows normal branch publication with CAS while retaining the original historical ancestor", async () => {
  const fork = versions.forkArtifactVersion(context(), one.revisionId, {
    title: "Branch",
    idempotencyKey: "fork",
  });
  const update = await pub.publishArtifact(context(), {
    ...input("branch-update"),
    artifactId: fork.artifactId,
    baseRevisionId: fork.revisionId,
  });
  expect(
    versions.getArtifactVersionHistory("s1", fork.artifactId),
  ).toMatchObject({ revisions: [update, fork], derivedFrom: one });
  expect(
    versions.getArtifactVersionHistory("s1", one.artifactId).branches,
  ).toEqual([update]);
  expect(pub.listRevisions("s1", one.artifactId)).toEqual([two, one]);
  await expect(
    pub.publishArtifact(context(), {
      ...input("stale-branch-update"),
      artifactId: fork.artifactId,
      baseRevisionId: fork.revisionId,
    }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
it("rolls back publication, lineage and outbox together if lineage persistence fails", () => {
  db.getRawSqlite().exec(
    "CREATE TRIGGER fail_lineage BEFORE INSERT ON agent_artifact_lineage BEGIN SELECT RAISE(ABORT, 'lineage failure'); END;",
  );
  expect(() =>
    versions.forkArtifactVersion(context(), one.revisionId, {
      title: "Branch",
      idempotencyKey: "fork",
    }),
  ).toThrow(/lineage failure/i);
  expect(pub.listArtifacts("s1")).toEqual([two]);
  expect(pub.pendingArtifactEvents("s1")).toHaveLength(2);
  expect(pub.listArtifactBuilds("s1")).toHaveLength(2);
  db.getRawSqlite().exec("DROP TRIGGER fail_lineage");
  expect(
    versions.forkArtifactVersion(context(), one.revisionId, {
      title: "Branch",
      idempotencyKey: "fork",
    }).revisionNumber,
  ).toBe(1);
});
it("keeps target private/model values intact without opt-in; simultaneous inheritance has one CAS winner", async () => {
  register();
  pub.saveArtifactState(
    "s1",
    two.revisionId,
    {
      schemaVersion: 1,
      controls: {},
      privateState: "target-secret",
      modelState: "target-model",
    },
    0,
  );
  const results = await Promise.allSettled([
    Promise.resolve().then(() => inherit({ expectedEtag: 1 })),
    Promise.resolve().then(() => inherit({ expectedEtag: 1 })),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "STATE_CONFLICT" },
  });
  expect(pub.getArtifactState("s1", two.revisionId)).toMatchObject({
    privateState: "target-secret",
    modelState: "target-model",
    controls: { size: 7 },
    etag: 2,
  });
});
it("rejects invalid and prototype-mutating schemas and normalizes object member ordering", () => {
  for (const raw of [
    { schemaVersion: 10001, controls: [] },
    { schemaVersion: 1, controls: [controls[0], controls[0]] },
    { schemaVersion: 1, controls: [{ ...controls[0], defaultValue: 100 }] },
    { schemaVersion: 1, controls: [{ ...controls[0], key: "constructor" }] },
    JSON.parse('{"schemaVersion":1,"controls":[],"__proto__":{}}'),
    {
      schemaVersion: 1,
      controls: [
        {
          key: "select",
          label: "Select",
          type: "select",
          defaultValue: "missing",
        },
      ],
    },
  ])
    expect(() =>
      versions.registerControlSchema("s1", one.revisionId, raw),
    ).toThrow();
  versions.registerControlSchema("s1", one.revisionId, schema);
  expect(
    versions.registerControlSchema("s1", one.revisionId, {
      controls: [
        {
          defaultValue: 2,
          max: 10,
          min: 1,
          type: "range",
          label: "Size",
          key: "size",
        },
      ],
      schemaVersion: 1,
    }),
  ).toEqual(schema);
});
it("fails closed on quota and pre-cancelled branch publication", async () => {
  const { ARTIFACT_LIMITS } = await import("../artifacts/contracts.js");
  const original = ARTIFACT_LIMITS.sessionBytes;
  try {
    (ARTIFACT_LIMITS as any).sessionBytes = 1;
    expect(() =>
      versions.forkArtifactVersion(context(), one.revisionId, {
        title: "Branch",
        idempotencyKey: "quota",
      }),
    ).toThrow(/quota/i);
  } finally {
    (ARTIFACT_LIMITS as any).sessionBytes = original;
  }
  const abort = new AbortController();
  abort.abort();
  expect(() =>
    versions.forkArtifactVersion(
      { ...context(), signal: abort.signal },
      one.revisionId,
      { title: "Branch", idempotencyKey: "abort" },
    ),
  ).toThrow(/cancel/i);
  expect(pub.listArtifacts("s1")).toEqual([two]);
  expect(
    versions.getArtifactVersionHistory("s1", one.artifactId).branches,
  ).toEqual([]);
});
it("does not make a revoked historical bundle runnable by relabeling it as a new publication", () => {
  // Emulate a persisted revision compiled under an older policy, without weakening production triggers.
  db.getRawSqlite().exec("DROP TRIGGER immutable_artifact_revision");
  db.getRawSqlite()
    .prepare("UPDATE agent_artifact_revisions SET policy_version=0 WHERE id=?")
    .run(one.revisionId);
  expect(() =>
    versions.forkArtifactVersion(context(), one.revisionId, {
      title: "Branch",
      idempotencyKey: "old-policy",
    }),
  ).toThrow(/rebuilding/i);
  expect(pub.listArtifacts("s1")).toEqual([two]);
  expect(
    versions.getArtifactVersionHistory("s1", one.artifactId).branches,
  ).toEqual([]);
});
it("cannot consume another session source even when target schema matches", async () => {
  register();
  const other = await pub.publishArtifact(
    { ...context(), sessionId: "s2" },
    input("other"),
  );
  versions.registerControlSchema("s2", other.revisionId, schema);
  expect(() =>
    versions.inspectStateInheritance("s1", two.revisionId, other.revisionId),
  ).toThrow(/not found/i);
  expect(() =>
    inherit({ sourceRevisionId: other.revisionId, sourceEtag: 0 }),
  ).toThrow(/not found/i);
});

it("initializes a virgin non-v1 state once and fences stale saves with a new etag", () => {
  const version2 = { ...schema, schemaVersion: 2 };
  const stale = pub.getArtifactState("s1", one.revisionId);
  expect(
    versions.registerControlSchema("s1", one.revisionId, version2),
  ).toEqual(version2);
  const initialized = pub.getArtifactState("s1", one.revisionId);
  expect(initialized).toEqual({
    schemaVersion: 2,
    etag: 1,
    controls: {},
    privateState: null,
    modelState: null,
  });
  versions.registerControlSchema("s1", one.revisionId, version2);
  expect(pub.getArtifactState("s1", one.revisionId)).toEqual(initialized);
  const { etag: staleEtag, ...staleState } = stale;
  expect(() =>
    pub.saveArtifactState("s1", one.revisionId, staleState, staleEtag),
  ).toThrow(/conflict/i);
  expect(() =>
    versions.registerControlSchema("s1", one.revisionId, schema),
  ).toThrow(/immutable/i);
});
it("rejects identical controls registered under v1 vs v2 and initializes non-v1 forks without copying state", () => {
  versions.registerControlSchema("s1", one.revisionId, schema);
  const version2 = { ...schema, schemaVersion: 2 };
  versions.registerControlSchema("s1", two.revisionId, version2);
  expect(
    versions.inspectStateInheritance("s1", two.revisionId, one.revisionId),
  ).toMatchObject({ compatible: false });
  expect(() => inherit({ sourceEtag: 0, expectedEtag: 1 })).toThrow(/schema/i);
  pub.saveArtifactState(
    "s1",
    two.revisionId,
    {
      schemaVersion: 2,
      controls: { size: 8 },
      privateState: "secret",
      modelState: "model",
    },
    1,
  );
  const fork = versions.forkArtifactVersion(context(), two.revisionId, {
    title: "v2 branch",
    idempotencyKey: "fork-v2",
  });
  expect(versions.getControlSchema("s1", fork.revisionId)).toEqual(version2);
  expect(pub.getArtifactState("s1", fork.revisionId)).toEqual({
    schemaVersion: 2,
    etag: 1,
    controls: {},
    privateState: null,
    modelState: null,
  });
  expect(
    versions.inheritArtifactState("s1", fork.revisionId, {
      sourceRevisionId: two.revisionId,
      sourceEtag: 2,
      expectedEtag: 1,
      includePrivateState: false,
      includeModelState: false,
      confirmSensitiveState: false,
    }),
  ).toEqual({
    schemaVersion: 2,
    etag: 2,
    controls: { size: 8 },
    privateState: null,
    modelState: null,
  });
});
it("never relabels previously saved state, even if empty, and leaves schema registration atomic on failure", () => {
  const saved = pub.saveArtifactState(
    "s1",
    one.revisionId,
    { schemaVersion: 1, controls: {}, privateState: null, modelState: null },
    0,
  );
  expect(() =>
    versions.registerControlSchema("s1", one.revisionId, {
      ...schema,
      schemaVersion: 2,
    }),
  ).toThrow(/saved state/i);
  expect(versions.getControlSchema("s1", one.revisionId)).toBeNull();
  expect(pub.getArtifactState("s1", one.revisionId)).toEqual(saved);
  const matching = pub.saveArtifactState(
    "s1",
    two.revisionId,
    {
      schemaVersion: 2,
      controls: { size: 4 },
      privateState: "keep",
      modelState: { page: "keep" },
    },
    0,
  );
  versions.registerControlSchema("s1", two.revisionId, {
    ...schema,
    schemaVersion: 2,
  });
  expect(pub.getArtifactState("s1", two.revisionId)).toEqual(matching);
});
it("rolls back non-v1 registration when state initialization fails", () => {
  db.getRawSqlite().exec(
    "CREATE TRIGGER fail_state_initialization BEFORE INSERT ON agent_artifact_state BEGIN SELECT RAISE(ABORT, 'state initialization failure'); END;",
  );
  expect(() =>
    versions.registerControlSchema("s1", one.revisionId, {
      ...schema,
      schemaVersion: 2,
    }),
  ).toThrow(/state initialization failure/);
  expect(versions.getControlSchema("s1", one.revisionId)).toBeNull();
  expect(pub.getArtifactState("s1", one.revisionId)).toMatchObject({
    schemaVersion: 1,
    etag: 0,
  });
});
it.each([0, -1, 1.5, 10001, "2", null, undefined])(
  "rejects schemaVersion %s without persisting metadata or state",
  (schemaVersion) => {
    expect(() =>
      versions.registerControlSchema("s1", one.revisionId, {
        controls,
        ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      }),
    ).toThrow();
    expect(versions.getControlSchema("s1", one.revisionId)).toBeNull();
    expect(pub.getArtifactState("s1", one.revisionId).etag).toBe(0);
  },
);
it("accepts the maximum explicit schema version", () => {
  versions.registerControlSchema("s1", one.revisionId, {
    controls,
    schemaVersion: 10000,
  });
  expect(pub.getArtifactState("s1", one.revisionId)).toMatchObject({
    schemaVersion: 10000,
    etag: 1,
  });
});
