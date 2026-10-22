import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionLiveStream } from "../useSessionLiveStream";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { useApiConnectivityStore as connectivity } from "../../../shared/lib/apiConnectivity";

vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
afterEach(() => store.setState(store.getInitialState()));

it("does not re-fetch cached session selection but reconciles the open row after a reconnect", () => {
  const refreshDetail = vi.fn().mockResolvedValue(undefined);
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  const syncSessionSummary = vi.fn().mockResolvedValue(undefined);
  store.setState({ refreshDetail, refreshSessions, syncSessionSummary });
  connectivity.setState({ apiReachable: "reachable" });
  const { rerender } = renderHook(({ id }) => useSessionLiveStream(id), {
    initialProps: { id: "a" },
  });
  rerender({ id: "b" });
  expect(refreshDetail).not.toHaveBeenCalled();
  expect(refreshSessions).not.toHaveBeenCalled();
  act(() => connectivity.setState({ apiReachable: "unreachable" }));
  act(() => connectivity.setState({ apiReachable: "reachable" }));
  expect(refreshDetail).toHaveBeenCalledTimes(1);
  // Only the open session is reconciled; the page is never re-read.
  expect(syncSessionSummary).toHaveBeenCalledWith("b");
  expect(refreshSessions).not.toHaveBeenCalled();
});
