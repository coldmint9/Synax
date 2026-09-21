import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  apiRequest,
  applyConnectivityFromResponse,
} from "../api/origin";
import { useApiConnectivityStore } from "../apiConnectivity";
import { useNotificationStore } from "../../react/state/notificationStore";
import { API_CONNECTIVITY_NOTIFICATION_ID } from "../apiConnectivity";

describe("apiRequest offline short-circuit", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "unreachable",
      failureCount: 3,
      lastCheckedAt: Date.now(),
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("skips fetch and does not spam notifications when already unreachable", async () => {
    await expect(apiRequest("/api/test")).rejects.toThrow("网络连接失败");
    await expect(apiRequest("/api/test")).rejects.toThrow("网络连接失败");

    expect(fetch).not.toHaveBeenCalled();
    const items = useNotificationStore.getState().notifications;
    expect(
      items.filter((n) => n.id === API_CONNECTIVITY_NOTIFICATION_ID),
    ).toHaveLength(0);
  });

  it("allows silent offline short-circuit without notification", async () => {
    await expect(apiRequest("/api/test", { silent: true })).rejects.toThrow();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});

describe("applyConnectivityFromResponse", () => {
  beforeEach(() => {
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "unknown",
      failureCount: 0,
      lastCheckedAt: null,
    });
  });

  it("marks success for ok and 4xx responses", () => {
    applyConnectivityFromResponse(new Response(null, { status: 200 }));
    expect(useApiConnectivityStore.getState().apiReachable).toBe("reachable");

    useApiConnectivityStore.setState({ apiReachable: "unknown" });
    applyConnectivityFromResponse(new Response(null, { status: 404 }));
    expect(useApiConnectivityStore.getState().apiReachable).toBe("reachable");
  });

  it("keeps endpoint-level 5xx failures out of global connectivity state", () => {
    applyConnectivityFromResponse(new Response(null, { status: 502 }));
    expect(useApiConnectivityStore.getState().apiReachable).toBe("unknown");

    applyConnectivityFromResponse(
      new Response("Internal error", { status: 500 }),
    );
    expect(useApiConnectivityStore.getState().apiReachable).toBe("unknown");
  });
});

describe("apiFetch gateway failure", () => {
  beforeEach(() => {
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "unknown",
      failureCount: 0,
      lastCheckedAt: null,
    });
  });

  it("does not let one 502 globally short-circuit later requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    );

    const first = await apiFetch("/api/agent-runtime/sessions");
    const second = await apiFetch("/api/agent-runtime/sessions");
    expect(first.status).toBe(502);
    expect(second.status).toBe(200);
    expect(useApiConnectivityStore.getState().apiReachable).toBe("reachable");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves intentional cancellation without marking the API offline or notifying", async () => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const request = apiRequest("/api/agent-runtime/sessions/search", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(useApiConnectivityStore.getState().apiReachable).toBe("unknown");
    expect(useApiConnectivityStore.getState().failureCount).toBe(0);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("does not mark the API offline when a superseded request is aborted", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const request = apiFetch("/api/events", { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(useApiConnectivityStore.getState().apiReachable).toBe("unknown");
    expect(useApiConnectivityStore.getState().failureCount).toBe(0);
  });
});
