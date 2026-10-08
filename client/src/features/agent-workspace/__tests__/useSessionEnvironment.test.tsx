import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi as api,
  type SessionEnvironment,
} from "../../../adapters/transport/agentRuntime";
import { useSessionEnvironment } from "../useSessionEnvironment";

const runtime = vi.hoisted(() => ({ handlers: [] as Record<string, (event: MessageEvent) => void>[] }));
vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: ({ events }: { events: Record<string, (event: MessageEvent) => void> }) => {
    runtime.handlers.push(events);
    return () => {};
  },
}));

afterEach(() => vi.restoreAllMocks());
const environment = (sessionId: string) =>
  ({ sessionId, branch: sessionId }) as SessionEnvironment;

it("shares concurrent requests and restores cached snapshots without crossing session boundaries", async () => {
  let resolve!: (value: SessionEnvironment) => void;
  const fetch = vi
    .spyOn(api, "getSessionEnvironment")
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValue(environment("env-b"));
  const first = renderHook(({ id }) => useSessionEnvironment(id), {
    initialProps: { id: "env-a" },
  });
  const second = renderHook(() => useSessionEnvironment("env-a"));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(environment("env-a"));
  });
  expect(first.result.current.environment?.sessionId).toBe("env-a");
  expect(second.result.current.environment?.sessionId).toBe("env-a");
  first.rerender({ id: "env-b" });
  expect(first.result.current.environment).toBeNull();
  await waitFor(() =>
    expect(first.result.current.environment?.sessionId).toBe("env-b"),
  );
  fetch.mockRejectedValue(new Error("offline"));
  first.rerender({ id: "env-a" });
  expect(first.result.current.environment?.sessionId).toBe("env-a");
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  expect(first.result.current.environment?.sessionId).toBe("env-a");
});

it("refreshes the parent snapshot for its child's status events but ignores unrelated sessions", async () => {
  const snapshot = {
    ...environment("env-parent"),
    subagents: [{ id: "env-child", status: "running" }],
  } as SessionEnvironment;
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(snapshot);
  const hook = renderHook(() => useSessionEnvironment("env-parent"));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(1);
  const handler = runtime.handlers.at(-1)!.session_changed;
  await act(async () => { handler(new MessageEvent("message", { data: JSON.stringify({ sessionId: "unrelated" }) })); });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue({ ...snapshot, subagents: [{ ...snapshot.subagents[0], status: "completed" }] });
  await act(async () => { handler(new MessageEvent("message", { data: JSON.stringify({ sessionId: "env-child" }) })); });
  await waitFor(() => expect(hook.result.current.environment?.subagents[0].status).toBe("completed"));
  expect(fetch).toHaveBeenCalledTimes(2);
});
