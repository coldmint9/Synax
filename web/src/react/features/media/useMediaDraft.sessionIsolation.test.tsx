import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeMedia, type RuntimeAsset } from "../../../lib/api/runtimeMedia";
import { mediaDraftItems, useMediaDraft } from "./useMediaDraft";

beforeEach(() => {
  vi.restoreAllMocks();
  mediaDraftItems.reset();
});

const asset = {
  id: "asset-a",
  filename: "a.png",
  mediaType: "image/png",
  size: 1,
} as RuntimeAsset;

describe("session draft media isolation", () => {
  it("finishes A's upload in A after switching to B, even across unmount", async () => {
    let finish!: (value: RuntimeAsset) => void;
    vi.spyOn(runtimeMedia, "upload").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderHook(
      ({ scope }) => useMediaDraft("p1", undefined, scope),
      { initialProps: { scope: "p1:a" } },
    );
    act(() =>
      view.result.current.add([
        new File(["a"], "a.png", { type: "image/png" }),
      ]),
    );
    const original = view.result.current.items[0];
    view.rerender({ scope: "p1:b" });
    expect(view.result.current.items).toEqual([]);
    expect(original.controller.signal.aborted).toBe(false);
    await act(async () => finish(asset));
    expect(view.result.current.parts).toEqual([]);
    view.unmount();
    const restored = renderHook(() => useMediaDraft("p1", undefined, "p1:a"));
    expect(restored.result.current.parts).toEqual([
      { type: "image", assetId: "asset-a" },
    ]);
    expect(restored.result.current.ready).toBe(true);
  });

  it("a captured clear operation only clears the originating scope", () => {
    const view = renderHook(
      ({ scope }) => useMediaDraft("p1", undefined, scope),
      { initialProps: { scope: "p1:a" } },
    );
    const attachment = {
      id: "a",
      file: new File(["a"], "a.png"),
      asset,
      controller: new AbortController(),
      uploading: false,
    };
    act(() => view.result.current.restore([attachment]));
    const clearA = view.result.current.clear;
    view.rerender({ scope: "p1:b" });
    act(() =>
      view.result.current.restore([
        { ...attachment, id: "b", controller: new AbortController() },
      ]),
    );
    act(() => clearA());
    expect(view.result.current.items[0].id).toBe("b");
    view.rerender({ scope: "p1:a" });
    expect(view.result.current.items).toEqual([]);
  });

  it("still aborts component-owned uploads on unmount and removes late assets", async () => {
    let finish!: (value: RuntimeAsset) => void;
    vi.spyOn(runtimeMedia, "upload").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const remove = vi
      .spyOn(runtimeMedia, "remove")
      .mockResolvedValue(undefined);
    const view = renderHook(() => useMediaDraft("p1"));
    act(() => view.result.current.add([new File(["a"], "a.png")]));
    const item = view.result.current.items[0];
    view.unmount();
    expect(item.controller.signal.aborted).toBe(true);
    await act(async () => finish(asset));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("asset-a"));
  });
});
