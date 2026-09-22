import type Database from "libsql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { versionDatabase } from "./version-store-fixture.js";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { RuntimeVersionRepository } from "../checkpoints/version-runtime/repository.js";
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
  repo.create("s", { id: "s" });
});
afterEach(() => db.close());
it("indexes execution scopes and preserves entity order across updates", () => {
  repo.putBatch("s", [
    {
      table: "steps",
      id: "a",
      fields: { id: "a", runId: "run-a", status: "running" },
    },
    {
      table: "steps",
      id: "b",
      fields: { id: "b", runId: "run-a", status: "running" },
    },
    {
      table: "steps",
      id: "c",
      fields: { id: "c", runId: "run-b", status: "running" },
    },
  ]);
  repo.put("s", "steps", "a", { id: "a", runId: "run-a", status: "completed" });
  expect(repo.page("s", "steps").items.map((row) => row.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(
    repo
      .page("s", "steps", { scope: { field: "runId", value: "run-a" } })
      .items.map((row) => row.id),
  ).toEqual(["a", "b"]);
  repo.put("s", "steps", "a", { id: "a", runId: "run-b", status: "completed" });
  expect(
    repo
      .page("s", "steps", { scope: { field: "runId", value: "run-a" } })
      .items.map((row) => row.id),
  ).toEqual(["b"]);
  expect(
    repo
      .page("s", "steps", { scope: { field: "runId", value: "run-b" } })
      .items.map((row) => row.id),
  ).toEqual(["a", "c"]);
});
it("does not scan unrelated run records for a scoped page", () => {
  for (let base = 0; base < 1000; base += 100)
    repo.putBatch(
      "s",
      Array.from({ length: 100 }, (_, n) => ({
        table: "parts",
        id: `p-${base + n}`,
        fields: {
          id: `p-${base + n}`,
          stepId: `step-${base + n}`,
          runId: "run",
        },
      })),
    );
  const spy = vi.spyOn(objects, "get");
  expect(
    repo
      .page("s", "parts", { scope: { field: "stepId", value: "step-500" } })
      .items.map((row) => row.id),
  ).toEqual(["p-500"]);
  expect(spy.mock.calls.length).toBeLessThan(15);
  spy.mockRestore();
});
