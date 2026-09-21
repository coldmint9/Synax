import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type SessionSearchResponse,
} from "../../../../lib/api/agentRuntime";
import { AppError } from "../../../../lib/appError";
import { useSessionSearch } from "../useSessionSearch";

const result = (id: string, hasMore = false) =>
  ({
    items: [{ session: { id }, snippet: "matching text" }],
    hasMore,
  }) as SessionSearchResponse;
const advance = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
describe("useSessionSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("debounces input, searches beyond the loaded list, and clears immediately", async () => {
    const search = vi
      .spyOn(agentRuntimeApi, "searchSessions")
      .mockResolvedValue(result("old"));
    const hook = renderHook(({ q }) => useSessionSearch("alpha", q), {
      initialProps: { q: "n" },
    });
    hook.rerender({ q: "needle" });
    expect(search).not.toHaveBeenCalled();
    await advance();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0].slice(0, 3)).toEqual(["alpha", "needle", 0]);
    expect(hook.result.current.items[0].session.id).toBe("old");
    hook.rerender({ q: " " });
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.items).toEqual([]);
  });
  it("aborts stale queries and prevents another workspace's response replacing results", async () => {
    let resolveOld!: (value: SessionSearchResponse) => void;
    const search = vi
      .spyOn(agentRuntimeApi, "searchSessions")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue(result("beta-session"));
    const hook = renderHook(
      ({ project }) => useSessionSearch(project, "needle"),
      { initialProps: { project: "alpha" } },
    );
    await advance();
    hook.rerender({ project: "beta" });
    expect(search.mock.calls[0][3]?.aborted).toBe(true);
    await advance();
    await act(async () => resolveOld(result("alpha-session")));
    expect(hook.result.current.items.map((item) => item.session.id)).toEqual([
      "beta-session",
    ]);
  });

  it("silently retries transient server failures before surfacing an error", async () => {
    const search = vi
      .spyOn(agentRuntimeApi, "searchSessions")
      .mockRejectedValueOnce(
        new AppError("temporary", { level: "system", statusCode: 503 }),
      )
      .mockResolvedValueOnce(result("recovered"));
    const hook = renderHook(() => useSessionSearch("alpha", "needle"));

    await advance();
    expect(search).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(hook.result.current.items[0].session.id).toBe("recovered");
    expect(hook.result.current.error).toBeNull();
  });
  it("cancels a scheduled retry when the query changes", async () => {
    const search = vi
      .spyOn(agentRuntimeApi, "searchSessions")
      .mockRejectedValueOnce(
        new AppError("temporary", { level: "system", statusCode: 500 }),
      )
      .mockResolvedValue(result("new-query"));
    const hook = renderHook(({ q }) => useSessionSearch("alpha", q), {
      initialProps: { q: "first" },
    });

    await advance();
    hook.rerender({ q: "second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][1]).toBe("second");
    expect(hook.result.current.items[0].session.id).toBe("new-query");
  });
  it("paginates and surfaces failures for retry", async () => {
    const search = vi
      .spyOn(agentRuntimeApi, "searchSessions")
      .mockResolvedValueOnce(result("a", true))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(result("b"));
    const hook = renderHook(() => useSessionSearch("alpha", "needle"));
    await advance();
    await act(async () => hook.result.current.loadMore());
    expect(hook.result.current.error).toBe("offline");
    expect(hook.result.current.items).toHaveLength(1);
    await act(async () => hook.result.current.loadMore());
    expect(search.mock.calls[2][2]).toBe(1);
    expect(hook.result.current.items.map((item) => item.session.id)).toEqual([
      "a",
      "b",
    ]);
    expect(hook.result.current.hasMore).toBe(false);
  });
});
