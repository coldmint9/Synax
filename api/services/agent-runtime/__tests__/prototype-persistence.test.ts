import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { getRawSqlite } from "../../../db/index.js";
import { compileCompletedPrototypes } from "../prototype-integration.js";
import { agentRuntimeRoutes } from "../../../routes/agent-runtime.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prototype-persist-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("stores immutable results in existing messages, preserves ordering, and leaves legacy storage empty", async () => {
  await fs.writeFile(
    path.join(root, "demo.html"),
    "<button>Saved demo</button>",
  );
  const m = store.appendMessage({
    id: "prototype-reply",
    sessionId: id,
    role: "assistant",
    runId: null,
    stepId: null,
    content:
      'Done\n```synax-prototype\n{"title":"Demo","sourcePath":"demo.html","sourceKind":"html"}\n```',
    metadata: { usage: { outputTokens: 4 }, extra: "kept" },
    createdAt: new Date().toISOString(),
  });
  store.appendMessage({
    ...m,
    id: "next-message",
    role: "user",
    content: "Next question",
    metadata: {},
  });
  const before = store.listMessages(id).map((m) => m.id);
  const stale = structuredClone(m);
  await compileCompletedPrototypes(m);
  await fs.unlink(path.join(root, "demo.html"));
  await compileCompletedPrototypes(stale); // Already compiled even when caller retained a stale object.
  const after = store.listMessages(id);
  expect(after.map((m) => m.id)).toEqual(before);
  expect(after[0].metadata).toMatchObject({
    source: "interactive_prototype",
    extra: "kept",
    usage: { outputTokens: 4 },
    prototypeDisplayText: "Done",
    prototypes: [{ title: "Demo", sourceKind: "html" }],
  });
  expect((after[0].metadata.prototypes as any)[0].html).toContain("Saved demo");
  const tables = getRawSqlite()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'artifact_%'",
    )
    .all() as { name: string }[];
  for (const { name } of tables)
    expect(
      (
        getRawSqlite()
          .prepare(`SELECT COUNT(*) AS count FROM "${name}"`)
          .get() as { count: number }
      ).count,
    ).toBe(0);
});
it("does not mount any retired artifact API", async () => {
  expect(
    (
      await agentRuntimeRoutes.request(`/sessions/${id}/artifacts`, {
        method: "POST",
      })
    ).status,
  ).toBe(404);
  // The pre-existing read-only evidence-artifact list is not the retired interactive platform.
  expect(
    (await agentRuntimeRoutes.request(`/sessions/${id}/artifacts`)).status,
  ).toBe(200);
  for (const tail of [
    "/jobs",
    "/revisions/old/bundle",
    "/revisions/old/state",
    "/revisions/old/feedback",
    "/revisions/old/screenshots",
    "/old/versions",
  ]) {
    for (const method of ["GET", "POST"])
      expect(
        (
          await agentRuntimeRoutes.request(`/sessions/${id}/artifacts${tail}`, {
            method,
          })
        ).status,
      ).toBe(404);
  }
});
it("cancellation never attaches executable metadata", async () => {
  const m = store.appendMessage({
    id: "cancelled-prototype",
    sessionId: id,
    role: "assistant",
    runId: null,
    stepId: null,
    content:
      '```synax-prototype\n{"title":"Demo","sourcePath":"demo.html","sourceKind":"html"}\n```',
    metadata: {},
    createdAt: "",
  });
  await expect(
    compileCompletedPrototypes(m, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(store.listMessages(id)[0].metadata.prototypes).toBeUndefined();
});
