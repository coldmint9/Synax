import { describe, expect, it, vi } from "vitest";
import { MediaCache } from "./mediaCache";

describe("MediaCache", () => {
  it("shares pending reads and reuses completed reads", async () => {
    const cache = new MediaCache<string>(10, (value) => value.length);
    const load = vi.fn(async () => "file");
    expect(await Promise.all([cache.get("a", load), cache.get("a", load)])).toEqual(["file", "file"]);
    expect(await cache.get("a", load)).toBe("file");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cancels one consumer without cancelling other consumers", async () => {
    const cache = new MediaCache<string>(10, () => 1);
    let finish!: (value: string) => void;
    const load = () => new Promise<string>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const first = cache.get("a", load, controller.signal);
    const second = cache.get("a", load);
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    finish("file");
    await expect(second).resolves.toBe("file");
  });

  it("evicts least recently used entries to respect the byte budget", async () => {
    const cache = new MediaCache<string>(8, (value) => value.length);
    cache.set("a", "aaaa");
    cache.set("b", "bbbb");
    await cache.get("a", async () => "unused");
    cache.set("c", "cccc");
    const reload = vi.fn(async () => "bbbb");
    await cache.get("b", reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("retries failed reads and does not restore invalidated pending entries", async () => {
    const cache = new MediaCache<string>(10, () => 1);
    await expect(cache.get("a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    let finish!: (value: string) => void;
    const pending = cache.get("a", () => new Promise<string>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    cache.delete("a");
    finish("old");
    await pending;
    await expect(cache.get("a", async () => "new")).resolves.toBe("new");
  });
});
