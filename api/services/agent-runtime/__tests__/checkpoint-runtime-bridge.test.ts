import { acceptRuntimeRun } from "../run-admission.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import {
  initializeVersionTranscript,
  versionRepository,
  versionedSession,
} from "../checkpoints/version-runtime/bridge.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { previewHistory, applyHistory } from "../checkpoints/operations.js";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeRoutes } from "../../../routes/agent-runtime.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-version-bridge-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
  initializeVersionTranscript(store.getSession(id), store.listEvents(id));
});
afterEach(async () => {
  const db = getRawSqlite();
  if (id) {
    db.prepare(
      "DELETE FROM conversation_v3_history_requests WHERE session_id=?",
    ).run(id);
    db.prepare("DELETE FROM conversation_v3_operations WHERE session_id=?").run(
      id,
    );
    db.prepare(
      "DELETE FROM conversation_v3_owned_versions WHERE session_id=?",
    ).run(id);
    db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(id);
  }
  await fs.rm(root, { recursive: true, force: true });
});
const message = (key: string, content = key) =>
  store.appendMessage({
    id: key,
    sessionId: id,
    role: "assistant",
    content,
    metadata: {},
    runId: null,
    stepId: null,
    createdAt: new Date().toISOString(),
  });
describe("real runtime transcript bridge", () => {
  it("routes real store message writes and history rollback through immutable versions", async () => {
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    expect(cp.payload.version).toBe(3);
    message("b");
    store.updateSessionMetadata(id, { future: "remove" });
    expect(
      getRawSqlite()
        .prepare(
          "SELECT count(*) AS n FROM agent_runtime_messages WHERE session_id=?",
        )
        .get(id),
    ).toMatchObject({ n: 0 });
    const preview = await previewHistory(id, cp.id, false);
    expect(preview.removedMessages).toBe(1);
    const request = {
      action: "rollback" as const,
      checkpointId: cp.id,
      revision: preview.revision,
      requestId: "undo",
      includeFiles: false,
    };
    const result = await applyHistory(id, request);
    expect(await applyHistory(id, request)).toEqual(result);
    expect(store.listMessages(id).map((m) => m.id)).toEqual(["a"]);
    expect(store.getSession(id).sessionMetadata?.future).toBeUndefined();
  });
  it("returns the original checkpoint on capture retry after later writes", async () => {
    message("a");
    const first = (await captureCheckpoint(id, "reply", "a"))!;
    message("b");
    const before = versionRepository().objects.stats();
    expect(await captureCheckpoint(id, "reply", "a")).toEqual(first);
    expect(versionRepository().objects.stats()).toEqual(before);
  });
  it("keeps live authorization changes after a history switch", async () => {
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    message("b");
    store.updateSessionMetadata(id, {
      permissionTier: "read-only",
      permissionOverrides: { filesystem: "deny" },
      future: true,
    });
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: versionRepository().head(id).revision,
      requestId: "undo",
      includeFiles: false,
    });
    expect(store.getSession(id).sessionMetadata).toMatchObject({
      permissionTier: "read-only",
      permissionOverrides: { filesystem: "deny" },
    });
    expect(store.getSession(id).sessionMetadata?.future).toBeUndefined();
  });
  it("uses the restored session view in lists as well as direct lookup", async () => {
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    store.updateSession(id, { prompt: "future-prompt" });
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: versionRepository().head(id).revision,
      requestId: "undo",
      includeFiles: false,
    });
    expect(
      store
        .listSessions({ projectId: plannerSessionInput.projectId })
        .find((session) => session.id === id)?.prompt,
    ).toBe(plannerSessionInput.prompt);
  });
  it("reports versioned event queries and removes their future after rollback", async () => {
    const event = (key: string, type: "thought_delta" | "message_delta") =>
      store.appendEvent({
        id: key,
        sessionId: id,
        type,
        summary: key,
        timestamp: "now",
        visibility: "user_visible",
        payload: {},
      });
    event("e1", "message_delta");
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    event("e2", "thought_delta");
    event("e3", "message_delta");
    expect(store.getLatestEventByType(id, "message_delta")?.id).toBe("e3");
    expect(store.countEventsAfter(id, "e1", "message_delta")).toBe(1);
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: versionRepository().head(id).revision,
      requestId: "undo",
      includeFiles: false,
    });
    expect(store.getLatestEventByType(id, "message_delta")?.id).toBe("e1");
    expect(store.countEventsAfter(id, "e1", "message_delta")).toBe(0);
  });
  it("uses real route pagination and explicitly rejects stale cursors", async () => {
    for (let n = 0; n < 70; n++) message(String(n));
    const response = await agentRuntimeRoutes.request(
      `/sessions/${id}/messages?limit=3`,
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items.map((m: { id: string }) => m.id)).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(page.next).toBeTruthy();
    message("new");
    const stale = await agentRuntimeRoutes.request(
      `/sessions/${id}/messages?cursor=${encodeURIComponent(page.next)}&limit=3`,
    );
    expect(stale.status).toBe(409);
  });
  it("pages events through the same bounded route contract as messages", async () => {
    for (let n = 0; n < 5; n++)
      store.appendEvent({
        id: `paged-event-${n}`,
        sessionId: id,
        type: "thought_delta",
        summary: "delta",
        timestamp: "now",
        visibility: "internal",
        payload: {},
      });
    const first = await (
      await agentRuntimeRoutes.request(`/sessions/${id}/events?limit=2`)
    ).json();
    expect(first.items).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = await (
      await agentRuntimeRoutes.request(
        `/sessions/${id}/events?limit=2&cursor=${encodeURIComponent(first.next)}`,
      )
    ).json();
    expect(second.items).toHaveLength(2);
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });
  it("exercises actual preview/rollback endpoints without legacy undo rows", async () => {
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    message("b");
    const post = (name: string, body: unknown) =>
      agentRuntimeRoutes.request(`/sessions/${id}/history/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const preview = await post("preview", {
      checkpointId: cp.id,
      action: "rollback",
      includeFiles: false,
    });
    expect(preview.status).toBe(200);
    const data = await preview.json(),
      request = {
        checkpointId: cp.id,
        revision: data.revision,
        requestId: "route",
        includeFiles: false,
      };
    const response = await post("rollback", request);
    expect(response.status).toBe(200);
    expect(await (await post("rollback", request)).json()).toEqual(
      await response.json(),
    );
    expect(
      getRawSqlite()
        .prepare(
          "SELECT count(*) AS n FROM conversation_history_journal WHERE session_id=?",
        )
        .get(id),
    ).toMatchObject({ n: 0 });
  });
  it("streams large content in bounded pages tied to the exact revision", async () => {
    message("large", "漢🙂".repeat(100000));
    const base = `/sessions/${id}/messages/large/content`;
    const first = await (await agentRuntimeRoutes.request(base)).json();
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(65536);
    expect(first.next).toBeDefined();
    expect(
      (await agentRuntimeRoutes.request(`${base}?cursor=${first.next}`)).status,
    ).toBe(409);
    const next = await agentRuntimeRoutes.request(
      `${base}?cursor=${first.next}&revision=${first.revision}`,
    );
    expect(next.status).toBe(200);
    message("new");
    expect(
      (
        await agentRuntimeRoutes.request(
          `${base}?cursor=${first.next}&revision=${first.revision}`,
        )
      ).status,
    ).toBe(409);
  });
  it("does not activate from a stale caller snapshot after the session starts running", () => {
    const normal = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: root,
    }).id;
    store.updateSession(normal, { status: "completed" });
    const snapshot = store.getSession(normal),
      events = store.listEvents(normal);
    store.updateSession(normal, { status: "running" });
    expect(() => initializeVersionTranscript(snapshot, events)).toThrow(
      /inactive|busy/i,
    );
    expect(versionedSession(normal)).toBe(false);
  });
  it("does not enable normal sessions by default or accept unsupported execution/file undo in the cohort", async () => {
    const normal = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: root,
    }).id;
    expect(versionedSession(normal)).toBe(false);
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    await expect(previewHistory(id, cp.id, true)).rejects.toThrow(
      /file|rollout/i,
    );
    const before = versionRepository().head(id);
    expect(() =>
      acceptRuntimeRun(id, { message: "do not start" }, "blocked"),
    ).toThrow(/rollout|not yet|not ready/i);
    expect(versionRepository().head(id)).toEqual(before);
    expect(() =>
      getRawSqlite()
        .prepare(
          "INSERT INTO agent_runtime_runs(id,session_id,status,started_at,current_step,metadata_json) VALUES('unsafe',?,'running','now',0,'{}')",
        )
        .run(id),
    ).toThrow(/VERSION_RUNTIME/i);
  });
});
