import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionLiveStream } from "../useSessionLiveStream";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { useApiConnectivityStore as connectivity } from "../../../../lib/apiConnectivity";

vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
afterEach(() => store.setState(store.getInitialState()));

it("does not re-fetch cached session selection but reconciles after a reconnect", () => {
  const refreshDetail = vi.fn().mockResolvedValue(undefined);
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  store.setState({ refreshDetail, refreshSessions });
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
  expect(refreshSessions).toHaveBeenCalledTimes(1);
});
