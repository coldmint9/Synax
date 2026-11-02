import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoResumeJournal } from "../journal.js";
import { AUTO_RESUME_JOURNAL_LIMIT, type AutoResumeRecord } from "../contracts.js";

let directory: string;
let file: string;

function record(sessionId: string, overrides: Partial<AutoResumeRecord> = {}): AutoResumeRecord {
  return {
    sessionId,
    projectId: "project-1",
    cause: "restart",
    phase: "queued",
    attempts: 0,
    networkWaits: 0,
    enqueuedAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "auto-resume-journal-"));
  file = path.join(directory, "runtime", "session-auto-resume.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("AutoResumeJournal", () => {
  it("publishes by rename so a reader never sees a partial file", async () => {
    const journal = new AutoResumeJournal(file);
    journal.put(record("session-1"));
    await journal.flush();
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      items: AutoResumeRecord[];
    };
    expect(raw.version).toBe(1);
    expect(raw.items.map((item) => item.sessionId)).toEqual(["session-1"]);
  });

  it("round-trips the queue and the suppressions across a restart", async () => {
    const first = new AutoResumeJournal(file);
    first.put(record("session-1", { phase: "waiting_network", lastError: "fetch failed" }));
    first.put(record("session-2"));
    first.suppress("session-9");
    await first.flush();

    const second = new AutoResumeJournal(file);
    await second.load();
    expect(second.list().map((item) => item.sessionId)).toEqual(["session-1", "session-2"]);
    expect(second.get("session-1")).toMatchObject({
      phase: "waiting_network",
      lastError: "fetch failed",
    });
    expect(second.isSuppressed("session-9")).toBe(true);
  });

  it("keeps one record per session and preserves its position", async () => {
    const journal = new AutoResumeJournal(file);
    journal.put(record("session-1"));
    journal.put(record("session-2"));
    journal.update("session-1", { phase: "retrying", attempts: 2 });
    expect(journal.list().map((item) => item.sessionId)).toEqual(["session-1", "session-2"]);
    expect(journal.get("session-1")).toMatchObject({ phase: "retrying", attempts: 2 });
  });

  it("trims the oldest records beyond the queue budget", () => {
    const journal = new AutoResumeJournal(file);
    for (let index = 0; index < AUTO_RESUME_JOURNAL_LIMIT + 8; index += 1)
      journal.put(
        record(`session-${index}`, {
          enqueuedAt: `2026-10-29T10:00:${String(index).padStart(2, "0")}.000Z`,
          updatedAt: `2026-10-29T10:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      );
    expect(journal.size()).toBe(AUTO_RESUME_JOURNAL_LIMIT);
    expect(journal.get("session-0")).toBeUndefined();
  });

  it("ignores an unreadable queue instead of blocking startup", async () => {
    await writeFile(path.join(directory, "broken.json"), "{not json", "utf8");
    const journal = new AutoResumeJournal(path.join(directory, "broken.json"));
    await expect(journal.load()).resolves.toEqual([]);
    expect(journal.size()).toBe(0);
    // A missing file is normal on first launch.
    const missing = new AutoResumeJournal(path.join(directory, "runtime", "missing.json"));
    await expect(missing.load()).resolves.toEqual([]);
  });

  it("drops records written by another schema version", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 99, items: [record("session-1")] }),
      "utf8",
    );
    const journal = new AutoResumeJournal(file);
    await journal.load();
    expect(journal.size()).toBe(0);
  });
});
