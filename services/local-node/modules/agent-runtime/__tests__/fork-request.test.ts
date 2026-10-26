import { expect, it, vi } from "vitest";
import { singleForkRequest } from "../fork-request.js";

it("allocates one workspace for concurrent identical fork requests", async () => {
  const ready = Promise.withResolvers<number>();
  const create = vi.fn(() => ready.promise);
  const first = singleForkRequest("session/request", "same-input", create);
  const retry = singleForkRequest("session/request", "same-input", create);
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
  await expect(singleForkRequest("session/request", "changed-input", create)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  ready.resolve(42);
  expect(await Promise.all([first, retry])).toEqual([42, 42]);
});

it("releases failed requests so a retry can recover its durable target", async () => {
  await expect(singleForkRequest("failed", "same-input", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect(await singleForkRequest("failed", "same-input", async () => "recovered")).toBe("recovered");
});
