import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "../../react/state/notificationStore";
import {
  API_CONNECTIVITY_NOTIFICATION_ID,
  notifyConnectivityFailure,
  probeApiHealth,
  startApiConnectivityMonitor,
  useApiConnectivityStore,
} from "../apiConnectivity";
import { handleError } from "../errors";
import { createOfflineError } from "../appError";

vi.mock("../api/runtimeEventBus", () => ({ resumeRuntimeEventBus: vi.fn() }));

describe("notifyConnectivityFailure", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "unknown",
      failureCount: 0,
      lastCheckedAt: null,
    });
  });

  it("aggregates repeated connectivity failures into one notification", () => {
    notifyConnectivityFailure("网络连接失败，无法访问后端服务");
    notifyConnectivityFailure("网络连接失败，无法访问后端服务");
    notifyConnectivityFailure("网络连接失败，无法访问后端服务");

    const items = useNotificationStore.getState().notifications;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(API_CONNECTIVITY_NOTIFICATION_ID);
    expect(items[0]?.message).toContain("3 次请求失败");
  });

  it("does not create a new notification when bump is false", () => {
    notifyConnectivityFailure("网络连接失败，无法访问后端服务");
    notifyConnectivityFailure("网络连接失败，无法访问后端服务", false);

    const items = useNotificationStore.getState().notifications;
    expect(items).toHaveLength(1);
    expect(items[0]?.aggregateCount).toBe(1);
  });
});

describe("handleError connectivity", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "unknown",
      failureCount: 0,
      lastCheckedAt: null,
    });
  });

  it("routes offline errors through aggregated connectivity notification", () => {
    handleError(createOfflineError());
    handleError(createOfflineError());

    const items = useNotificationStore.getState().notifications;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(API_CONNECTIVITY_NOTIFICATION_ID);
    expect(items[0]?.message).toContain("2 次请求失败");
  });

  it("aggregates fetch network TypeError failures", () => {
    handleError(new TypeError("Failed to fetch"));
    handleError(new TypeError("Failed to fetch"));

    const items = useNotificationStore.getState().notifications;
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toContain("2 次请求失败");
    expect(useApiConnectivityStore.getState().apiReachable).toBe("unreachable");
  });

  it("ignores intentional request cancellation", () => {
    handleError(new DOMException("Aborted", "AbortError"));

    expect(useApiConnectivityStore.getState().apiReachable).toBe("unknown");
    expect(useApiConnectivityStore.getState().failureCount).toBe(0);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});

describe("useApiConnectivityStore", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "unknown",
      failureCount: 0,
      lastCheckedAt: null,
    });
  });

  it("dismisses connectivity toast after recovery", () => {
    useApiConnectivityStore.setState({ apiReachable: "unreachable" });
    notifyConnectivityFailure("offline");
    useApiConnectivityStore.getState().markSuccess();

    const toast = useNotificationStore
      .getState()
      .notifications.find((n) => n.id === API_CONNECTIVITY_NOTIFICATION_ID);
    expect(toast?.visible).toBe(false);
  });

  it("blocks requests while unreachable", () => {
    useApiConnectivityStore.setState({ apiReachable: "unreachable" });
    expect(useApiConnectivityStore.getState().shouldSkipRequest()).toBe(true);
  });
});

describe("connectivity monitor wake recovery", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    useApiConnectivityStore.setState({
      browserOnline: true,
      apiReachable: "reachable",
      recoveryVersion: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    stop?.();
    await vi.advanceTimersByTimeAsync(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("probes and publishes one recovery for a burst of visible/focus/online events", async () => {
    stop = startApiConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useApiConnectivityStore.getState().recoveryVersion).toBe(1);
  });

  it("detects timer suspension even without browser lifecycle events", async () => {
    stop = startApiConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useApiConnectivityStore.getState().recoveryVersion).toBe(1);
  });

  it("keeps retrying when the network is not ready at wake time", async () => {
    stop = startApiConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useApiConnectivityStore.getState().apiReachable).toBe("unreachable");
    expect(useApiConnectivityStore.getState().recoveryVersion).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useApiConnectivityStore.getState().apiReachable).toBe("reachable");
    expect(useApiConnectivityStore.getState().recoveryVersion).toBe(1);
  });

  it("resynchronizes a stale browser offline flag on focus", async () => {
    stop = startApiConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(0);
    useApiConnectivityStore.getState().setBrowserOnline(false);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useApiConnectivityStore.getState().shouldSkipRequest()).toBe(false);
  });

  it("coalesces health probes and retains a wake request while a probe is pending", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const first = probeApiHealth();
    const resumed = probeApiHealth(true);
    expect(resumed).toBe(first);
    resolve(new Response(null, { status: 200 }));
    await resumed;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useApiConnectivityStore.getState().recoveryVersion).toBe(1);
  });

  it("removes lifecycle listeners and timers on stop", async () => {
    stop = startApiConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
