import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runtimeMedia,
  type RuntimeAsset,
} from "../../adapters/transport/runtimeMedia";
import {
  mediaDraftItems,
  resetMediaUploadQueue,
  useMediaDraft,
} from "./useMediaDraft";

beforeEach(() => {
  vi.restoreAllMocks();
  mediaDraftItems.reset();
  resetMediaUploadQueue();
});

function makeAsset(name: string): RuntimeAsset {
  return {
    id: `asset-${name}`,
    projectId: "p1",
    filename: name,
    mediaType: "text/plain",
    size: 1,
    sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as RuntimeAsset;
}

function file(name: string) {
  return new File([name], name, { type: "text/plain" });
}

describe("background attachment uploads", () => {
  it("shows attachments immediately and never runs more than two uploads", async () => {
    let active = 0;
    let peak = 0;
    const settling: Array<() => void> = [];
    const started: string[] = [];
    vi.spyOn(runtimeMedia, "upload").mockImplementation(((_project, item) => {
      started.push(item.name);
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<RuntimeAsset>((resolve) => {
        settling.push(() => {
          active -= 1;
          resolve(makeAsset(item.name));
        });
      });
    }) as never);

    const view = renderHook(() => useMediaDraft("p1"));
    act(() => view.result.current.add([file("a.txt"), file("b.txt"), file("c.txt")]));

    // Everything is in the draft right away, only two requests are running.
    expect(view.result.current.items).toHaveLength(3);
    expect(view.result.current.items.every((item) => item.uploading)).toBe(true);
    expect(view.result.current.items.filter((item) => item.queued)).toHaveLength(1);
    expect(view.result.current.blocked).toBe(false);
    expect(started).toEqual(["a.txt", "b.txt"]);

    // Draining the first upload lets the queued one start without exceeding 2.
    await act(async () => settling.shift()!());
    await waitFor(() => expect(started).toEqual(["a.txt", "b.txt", "c.txt"]));
    expect(peak).toBe(2);

    await act(async () => settling.shift()!());
    await act(async () => settling.shift()!());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.items.map((item) => item.asset?.id)).toEqual([
      "asset-a.txt",
      "asset-b.txt",
      "asset-c.txt",
    ]);
  });

  it("lets a send wait for the uploads still in flight", async () => {
    let finish!: () => void;
    vi.spyOn(runtimeMedia, "upload").mockImplementation(
      () =>
        new Promise<RuntimeAsset>((resolve) => {
          finish = () => resolve(makeAsset("a.txt"));
        }),
    );

    const view = renderHook(() => useMediaDraft("p1"));
    act(() => view.result.current.add([file("a.txt")]));

    // Uploading does not block the editor: no parts yet, but nothing failed.
    expect(view.result.current.hasPendingUploads()).toBe(true);
    expect(view.result.current.parts).toEqual([]);
    expect(view.result.current.blocked).toBe(false);

    const settlement = view.result.current.waitForUploads();
    await act(async () => finish());
    await expect(settlement).resolves.toEqual({
      parts: [{ type: "file", assetId: "asset-a.txt" }],
      itemIds: [view.result.current.items[0].id],
    });
    expect(view.result.current.hasPendingUploads()).toBe(false);
  });

  it("reports a failed upload without dropping the attachment", async () => {
    vi.spyOn(runtimeMedia, "upload").mockRejectedValue(new Error("boom"));

    const view = renderHook(() => useMediaDraft("p1"));
    act(() => view.result.current.add([file("a.txt")]));

    await waitFor(() =>
      expect(view.result.current.items[0].error).toBe("boom"),
    );
    expect(view.result.current.blocked).toBe(true);
    expect(view.result.current.items).toHaveLength(1);
    await expect(view.result.current.waitForUploads()).rejects.toThrow(/boom/);
  });

  it("frees a queue slot when a waiting attachment is removed", async () => {
    const settling: Array<() => void> = [];
    const started: string[] = [];
    vi.spyOn(runtimeMedia, "upload").mockImplementation(((_project, item) => {
      started.push(item.name);
      return new Promise<RuntimeAsset>((resolve) => {
        settling.push(() => resolve(makeAsset(item.name)));
      });
    }) as never);

    const view = renderHook(() => useMediaDraft("p1"));
    act(() =>
      view.result.current.add([file("a.txt"), file("b.txt"), file("c.txt")]),
    );
    const queued = view.result.current.items.find((item) => item.queued)!;
    act(() => view.result.current.remove(queued.id));
    expect(started).toEqual(["a.txt", "b.txt"]);

    // The removed draft must not upload, and the freed slot takes new work.
    await act(async () => settling.shift()!());
    act(() => view.result.current.add([file("d.txt")]));
    await waitFor(() => expect(started).toEqual(["a.txt", "b.txt", "d.txt"]));
  });
});
