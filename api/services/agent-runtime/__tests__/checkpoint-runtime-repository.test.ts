import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionCollector } from "../checkpoints/version-store/gc.js";
import { RuntimeVersionRepository } from "../checkpoints/version-runtime/repository.js";
import { versionDatabase } from "./version-store-fixture.js";
let db: Database.Database,
  objects: VersionObjects,
  repo: RuntimeVersionRepository;
beforeEach(() => {
  db = versionDatabase();
  objects = new VersionObjects(db, {
    maxBytes: 64 * 1024 * 1024,
    maxObjects: 100000,
  });
  repo = new RuntimeVersionRepository(objects);
  repo.create("s", {
    id: "s",
    prompt: "start",
    sessionMetadata: { userPrompt: "start" },
  });
});
afterEach(() => db.close());
const message = (id: string, content = id) => ({
  id,
  sessionId: "s",
  role: "assistant",
  content,
  metadata: {},
  runId: null,
  stepId: null,
  createdAt: "now",
});
describe("runtime version repository", () => {
  it("publishes messages and historical session fields and switches them back together", () => {
    repo.put("s", "messages", "a", message("a"));
    const cp = repo.capture("s", "reply", "a", null, 0);
    repo.put("s", "messages", "b", message("b"));
    repo.session("s", {
      id: "s",
      prompt: "changed",
      sessionMetadata: { future: true },
    });
    const revision = repo.head("s").revision;
    expect(repo.preview("s", cp.id).removedMessages).toBe(1);
    const request = { checkpointId: cp.id, revision, requestId: "undo" };
    const result = repo.rollback("s", request);
    expect(repo.page("s", "messages").items.map((m) => m.id)).toEqual(["a"]);
    expect(repo.readSession("s").prompt).toBe("start");
    expect(repo.rollback("s", request)).toEqual(result);
    expect(repo.head("s").epoch).toBe(2);
  });
  it("keeps old checkpoints alive through GC and excludes popped checkpoints by prefix", () => {
    repo.put("s", "messages", "a", message("a"));
    const a = repo.capture("s", "reply", "a", null, 0);
    repo.put("s", "messages", "b", message("b"));
    const b = repo.capture("s", "reply", "b", null, 0);
    const gc = new VersionCollector(objects);
    for (let i = 0; i < 100 && gc.collect().remaining; i++);
    expect(repo.checkpoint("s", a.id).messageId).toBe("a");
    repo.rollback("s", {
      checkpointId: a.id,
      revision: repo.head("s").revision,
      requestId: "undo",
    });
    expect(() => repo.checkpoint("s", b.id)).toThrow(/checkpoint/i);
    repo.put("s", "messages", "c", message("c"));
    const c = repo.capture("s", "reply", "c", null, 0);
    expect(c.ordinal).toBeGreaterThan(b.ordinal);
    expect(repo.checkpoints("s").items.map((cp) => cp.id)).toEqual([
      a.id,
      c.id,
    ]);
  });
  it("deduplicates capture retries even after intervening writes without allocating a new snapshot", () => {
    repo.put("s", "messages", "a", message("a"));
    const cp = repo.capture("s", "reply", "a", null, 0);
    repo.put("s", "messages", "b", message("b"));
    const stats = objects.stats(),
      head = repo.head("s");
    expect(repo.capture("s", "reply", "a", "ignored-retry-step", 99)).toEqual(
      cp,
    );
    expect(objects.stats()).toEqual(stats);
    expect(repo.head("s")).toEqual(head);
    expect(repo.checkpoints("s").items.map((item) => item.id)).toEqual([cp.id]);
    expect(repo.capture("s", "input", "a", null, 0).id).not.toBe(cp.id);
  });
  it("restores capture identity lookup on rollback without reviving a popped checkpoint", () => {
    repo.put("s", "messages", "a", message("a"));
    const a = repo.capture("s", "reply", "a", null, 0);
    repo.put("s", "messages", "b", message("b"));
    const b = repo.capture("s", "reply", "b", null, 0);
    repo.rollback("s", {
      checkpointId: a.id,
      revision: repo.head("s").revision,
      requestId: "undo",
    });
    repo.put("s", "messages", "b", message("b", "new branch"));
    const replacement = repo.capture("s", "reply", "b", null, 0);
    expect(replacement.id).not.toBe(b.id);
    expect(replacement.ordinal).toBeGreaterThan(b.ordinal);
    expect(repo.capture("s", "reply", "a", null, 0)).toEqual(a);
    expect(repo.checkpoints("s").items.map((item) => item.id)).toEqual([
      a.id,
      replacement.id,
    ]);
    const gc = new VersionCollector(objects);
    for (let n = 0; n < 100 && gc.collect().remaining; n++);
    expect(repo.capture("s", "reply", "b", null, 0)).toEqual(replacement);
  });
  it("keeps a conservative file retention floor until its checkpoint prefix is empty", () => {
    const floor = () =>
      db
        .prepare(
          "SELECT file_retention_floor AS value FROM conversation_v3_heads WHERE session_id='s'",
        )
        .get() as { value: number | null };
    expect(floor()).toMatchObject({ value: null });
    const first = repo.capture("s", "input", "first-input", null, 10);
    repo.capture("s", "reply", "later", null, 20);
    expect(floor()).toMatchObject({ value: 10 });
    repo.rollback("s", {
      checkpointId: first.id,
      revision: repo.head("s").revision,
      requestId: "edit-floor",
      action: "edit",
    });
    expect(floor()).toMatchObject({ value: null });
    repo.capture("s", "reply", "new-branch", null, 30);
    expect(floor()).toMatchObject({ value: 30 });
  });
  it("paginates a fixed version and rejects unpinned stale page versions", () => {
    for (let n = 0; n < 20; n++)
      repo.put("s", "messages", String(n), message(String(n)));
    const page = repo.page("s", "messages", { limit: 3 });
    expect(page.items.map((m) => m.id)).toEqual(["0", "1", "2"]);
    expect(
      repo
        .page("s", "messages", { limit: 3, cursor: page.next })
        .items.map((m) => m.id),
    ).toEqual(["3", "4", "5"]);
    repo.put("s", "messages", "new", message("new"));
    expect(() => repo.page("s", "messages", { cursor: page.next })).toThrow(
      /changed|stale/i,
    );
  });
  it("replaces an existing message without retaining a duplicate in the ordered view", () => {
    repo.put("s", "messages", "a", message("a"));
    repo.put("s", "messages", "b", message("b"));
    repo.put("s", "messages", "a", message("a", "updated"));
    expect(
      repo.page("s", "messages").items.map((m) => [m.id, m.content]),
    ).toEqual([
      ["b", "b"],
      ["a", "updated"],
    ]);
    expect(repo.count("s", "messages")).toBe(2);
  });
  it("does not let a small page silently materialize a huge field", () => {
    repo.put(
      "s",
      "messages",
      "large",
      message("large", "x".repeat(2 * 1024 * 1024)),
    );
    expect(() => repo.page("s", "messages", { maxBytes: 1024 })).toThrow(
      /budget|projection/i,
    );
    expect(
      repo.page("s", "messages", { maxBytes: 1024, fields: ["id", "role"] })
        .items,
    ).toEqual([{ id: "large", role: "assistant" }]);
    expect(
      repo.content("s", "messages", "large", "content").text.length,
    ).toBeLessThanOrEqual(65536);
  });
  it("validates content continuation revision in the same snapshot that reads it", () => {
    repo.put("s", "messages", "large", message("large", "a".repeat(200000)));
    const page = repo.content("s", "messages", "large", "content");
    repo.put("s", "messages", "large", message("large", "b".repeat(200000)));
    expect(() =>
      repo.content(
        "s",
        "messages",
        "large",
        "content",
        page.next,
        page.revision,
      ),
    ).toThrow(/changed|stale/i);
  });
  it("rejects input checkpoints on the reply rollback path", () => {
    const checkpoint = repo.capture("s", "input", "future-user", null, 0);
    const head = repo.head("s");
    expect(() =>
      repo.rollback("s", {
        checkpointId: checkpoint.id,
        revision: head.revision,
        requestId: "wrong-kind",
      }),
    ).toThrow(/reply|boundary/i);
    expect(repo.head("s")).toEqual(head);
  });
  it("rejects stale revisions and request-id conflicts without modifying a head", () => {
    repo.put("s", "messages", "a", message("a"));
    const cp = repo.capture("s", "reply", "a", null, 0);
    const revision = repo.head("s").revision;
    repo.put("s", "messages", "b", message("b"));
    expect(() =>
      repo.rollback("s", { checkpointId: cp.id, revision, requestId: "undo" }),
    ).toThrow(/revision/i);
    const request = {
      checkpointId: cp.id,
      revision: repo.head("s").revision,
      requestId: "undo",
    };
    repo.rollback("s", request);
    expect(() =>
      repo.rollback("s", { ...request, revision: request.revision + 1 }),
    ).toThrow(/request/i);
  });
  it("reads one consistent snapshot while another connection switches and collects the old root", () => {
    const directory = mkdtempSync(
        path.join(os.tmpdir(), "synax-runtime-read-snapshot-"),
      ),
      file = path.join(directory, "test.db");
    const a = versionDatabase(file),
      b = versionDatabase(file);
    try {
      a.exec("PRAGMA journal_mode=WAL");
      b.exec("PRAGMA journal_mode=WAL");
      const leftObjects = new VersionObjects(a, {
          maxBytes: 64 * 1024 * 1024,
          maxObjects: 100000,
        }),
        rightObjects = new VersionObjects(b, {
          maxBytes: 64 * 1024 * 1024,
          maxObjects: 100000,
        });
      const left = new RuntimeVersionRepository(leftObjects),
        right = new RuntimeVersionRepository(rightObjects);
      left.create("s", { id: "s", prompt: "start" });
      left.put("s", "messages", "a", message("a"));
      const get = leftObjects.get.bind(leftObjects);
      let switched = false;
      const spy = vi.spyOn(leftObjects, "get").mockImplementation((...args) => {
        if (!switched) {
          switched = true;
          right.put("s", "messages", "b", message("b"));
          const gc = new VersionCollector(rightObjects);
          for (let n = 0; n < 100 && gc.collect().remaining; n++);
        }
        return get(...args);
      });
      try {
        expect(left.page("s", "messages").items.map((row) => row.id)).toEqual([
          "a",
        ]);
      } finally {
        spy.mockRestore();
      }
      expect(left.page("s", "messages").items.map((row) => row.id)).toEqual([
        "a",
        "b",
      ]);
    } finally {
      b.close();
      a.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
