import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import {
  initializeVersionTranscript,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { VersionCollector } from "../checkpoints/version-store/gc.js";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeRoutes } from "../../../routes/agent-runtime.js";

it("rolls back a real 10k-event transcript through the route without history-proportional SQL", async () => {
  resetAgentRuntimeFixtures();
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synax-runtime-scale-"),
  );
  let id: string | undefined;
  try {
    id = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: directory,
    }).id;
    store.updateSession(id, { status: "completed" });
    initializeVersionTranscript(store.getSession(id), store.listEvents(id));
    const addMessage = (key: string) =>
      store.appendMessage({
        id: key,
        sessionId: id!,
        runId: null,
        stepId: null,
        role: "assistant",
        content: key,
        metadata: {},
        createdAt: "now",
      });
    addMessage("before");
    const checkpoint = (await captureCheckpoint(id, "reply", "before"))!;
    const repo = versionRepository(),
      gc = new VersionCollector(repo.objects),
      db = getRawSqlite();
    const generationStart = performance.now();
    for (let base = 0; base < 10000; base += 32) {
      store.appendEvents(
        Array.from({ length: Math.min(32, 10000 - base) }, (_, offset) => ({
          id: `event-${base + offset}`,
          sessionId: id!,
          type: "thought_delta" as const,
          timestamp: "now",
          visibility: "internal" as const,
          summary: "delta",
          payload: { delta: `${base + offset}` },
        })),
      );
      // Explicit maintenance harness, not a claim that a runtime scheduler exists.
      for (
        let batch = 0;
        batch < 64 &&
        gc.collect({ maxObjects: 256, maxEdges: 65536, maxMs: 1000 }).remaining;
        batch++
      );
    }
    const generationMs = performance.now() - generationStart;
    addMessage("after");
    const revision = repo.head(id).revision;
    const nativeGet = repo.objects.get.bind(repo.objects);
    let reads = 0;
    const spy = vi.spyOn(repo.objects, "get").mockImplementation((...args) => {
      reads++;
      return nativeGet(...args);
    });
    const start = performance.now();
    const response = await agentRuntimeRoutes.request(
      `/sessions/${id}/history/rollback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: checkpoint.id,
          revision,
          requestId: "scale",
          includeFiles: false,
        }),
      },
    );
    const elapsed = performance.now() - start;
    spy.mockRestore();
    expect(response.status).toBe(200);
    expect(reads).toBeLessThan(100);
    expect(store.listMessages(id).map((message) => message.id)).toEqual([
      "before",
    ]);
    expect(store.getLatestEventByType(id, "thought_delta")).toBeNull();
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM conversation_history_journal WHERE session_id=?",
        )
        .get(id),
    ).toMatchObject({ n: 0 });
    const report = {
      scope: "actual-transcript-route-only",
      events: 10000,
      batchRows: 32,
      generationMs,
      objectStats: repo.objects.stats(),
      rollbackMs: elapsed,
      immutableObjectReads: reads,
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    };
    console.log("VERSION_RUNTIME_SCALE", JSON.stringify(report));
    if (process.env.SYNAX_SCALE_REPORT)
      await fs.writeFile(
        process.env.SYNAX_SCALE_REPORT,
        JSON.stringify(report, null, 2),
        { flag: "wx" },
      );
  } finally {
    if (id) {
      const db = getRawSqlite();
      db.prepare(
        "DELETE FROM conversation_v3_history_requests WHERE session_id=?",
      ).run(id);
      db.prepare(
        "DELETE FROM conversation_v3_operations WHERE session_id=?",
      ).run(id);
      db.prepare(
        "DELETE FROM conversation_v3_owned_versions WHERE session_id=?",
      ).run(id);
      db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(
        id,
      );
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 120000);
