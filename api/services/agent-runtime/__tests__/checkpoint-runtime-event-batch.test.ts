import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentEventService } from "../event-service.js";
import {
  initializeVersionTranscript,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import { getRawSqlite } from "../../../db/index.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import type { RuntimeEvent } from "../contracts.js";
let root: string,
  id: string,
  versioned = false;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  versioned = false;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-event-batch-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
});
afterEach(async () => {
  const db = getRawSqlite();
  db.exec("DROP TRIGGER IF EXISTS reject_event_batch");
  if (versioned) {
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
const event = (key: string): RuntimeEvent => ({
  id: key,
  sessionId: id,
  type: "thought_delta",
  timestamp: "now",
  summary: key,
  visibility: "internal",
  payload: { delta: key },
});
function enable() {
  initializeVersionTranscript(store.getSession(id), store.listEvents(id));
  versioned = true;
}
describe.each([false, true])("actual event batch, versioned=%s", (v3) => {
  it("persists the caller order and enriches service events with the active work identity", () => {
    if (v3) enable();
    store.updateSessionMetadata(id, { activeWorkId: "work-1" });
    const before = v3 ? versionRepository().head(id).revision : 0;
    const result = store.appendEvents([event("a"), event("b")]);
    expect(result.map((row) => row.id)).toEqual(["a", "b"]);
    if (v3) expect(versionRepository().head(id).revision).toBe(before + 1);
    const created = agentEventService.appendBatch([
      {
        sessionId: id,
        type: "thought_delta",
        summary: "one",
        payload: { delta: "one" },
      },
      {
        sessionId: id,
        type: "message_delta",
        summary: "two",
        payload: { delta: "two" },
      },
    ]);
    expect(created.map((row) => row.payload.workId)).toEqual([
      "work-1",
      "work-1",
    ]);
    expect(
      store
        .listEvents(id)
        .slice(-4)
        .map((row) => row.summary),
    ).toEqual(["a", "b", "one", "two"]);
  });
  it("rejects mixed sessions and oversized bursts without persistence", () => {
    if (v3) enable();
    const before = store.listEvents(id).map((row) => row.id);
    expect(() =>
      store.appendEvents([event("a"), { ...event("b"), sessionId: "other" }]),
    ).toThrow(/session/i);
    expect(() =>
      store.appendEvents(
        Array.from({ length: 257 }, (_, n) => event(String(n))),
      ),
    ).toThrow(/batch|limit/i);
    expect(() =>
      agentEventService.appendBatch([
        {
          sessionId: id,
          type: "thought_delta",
          summary: "too-big",
          payload: { delta: "x".repeat(1024 * 1024) },
        },
      ]),
    ).toThrow(/budget/i);
    expect(store.listEvents(id).map((row) => row.id)).toEqual(before);
  });
});
it("rolls back a late legacy SQL failure and its undo-trigger changes", () => {
  const db = getRawSqlite(),
    before = store.listEvents(id).map((row) => row.id);
  db.prepare(
    "INSERT OR IGNORE INTO conversation_history_tracking(session_id) VALUES(?)",
  ).run(id);
  db.exec(
    "CREATE TRIGGER reject_event_batch BEFORE INSERT ON agent_runtime_events WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'injected event failure'); END",
  );
  expect(() => store.appendEvents([event("good"), event("bad")])).toThrow(
    "injected event failure",
  );
  expect(store.listEvents(id).map((row) => row.id)).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM conversation_history_journal WHERE session_id=?",
      )
      .get(id),
  ).toMatchObject({ n: 0 });
});
