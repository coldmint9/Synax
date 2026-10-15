import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStaleResourceCache,
  fetchStaleResource,
  readStaleResource,
  writeStaleResource,
} from "../staleResource";

describe("staleResource", () => {
  beforeEach(() => clearStaleResourceCache());

  it("deduplicates a refresh while serving the previous value", async () => {
    writeStaleResource("branches", { items: ["main"] });
    let resolve!: (value: { items: string[] }) => void;
    const loader = vi.fn(
      () => new Promise<{ items: string[] }>((next) => (resolve = next)),
    );

    const first = fetchStaleResource("branches", loader);
    const second = fetchStaleResource("branches", loader);
    await Promise.resolve();

    expect(readStaleResource("branches")).toEqual({ items: ["main"] });
    expect(loader).toHaveBeenCalledOnce();
    expect(first).toBe(second);

    resolve({ items: ["main", "feature/ui"] });
    await expect(first).resolves.toEqual({ items: ["main", "feature/ui"] });
    expect(readStaleResource("branches")).toEqual({
      items: ["main", "feature/ui"],
    });
  });

  it("keeps stale data when the background refresh fails", async () => {
    writeStaleResource("workspace", { path: "/repo" });
    await expect(
      fetchStaleResource("workspace", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(readStaleResource("workspace")).toEqual({ path: "/repo" });
  });
});
