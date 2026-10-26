import { afterEach, expect, it, vi } from "vitest";
import { apiRequest } from "../origin";
import { agentRuntimeApi } from "../agentRuntime";
import { HISTORY_REQUEST_TIMEOUT_MS, requestHistory } from "../historyRequest";

vi.mock("../origin", () => ({ apiRequest: vi.fn(), apiFetch: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("aborts a stalled read and lets a new attempt succeed even if the old promise never settles", async () => {
  vi.useFakeTimers();
  vi.mocked(apiRequest).mockReturnValueOnce(new Promise(() => {}));
  const pending = requestHistory("/api/history");
  const rejected = expect(pending).rejects.toMatchObject({ code: "HISTORY_TIMEOUT" });
  const signal = vi.mocked(apiRequest).mock.calls[0][1]!.signal!;
  await vi.advanceTimersByTimeAsync(HISTORY_REQUEST_TIMEOUT_MS);
  await rejected;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.mocked(apiRequest).mockResolvedValueOnce({ messages: ["older"] });
  await expect(requestHistory("/api/history")).resolves.toEqual({ messages: ["older"] });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["success", "failure"])("clears its deadline after a prompt %s", async outcome => {
  vi.useFakeTimers();
  if (outcome === "success") vi.mocked(apiRequest).mockResolvedValueOnce({ ok: true });
  else vi.mocked(apiRequest).mockRejectedValueOnce(new Error("offline"));
  const pending = requestHistory("/api/history");
  if (outcome === "success") await expect(pending).resolves.toEqual({ ok: true });
  else await expect(pending).rejects.toThrow("offline");
  const signal = vi.mocked(apiRequest).mock.calls[0][1]!.signal!;
  await vi.advanceTimersByTimeAsync(HISTORY_REQUEST_TIMEOUT_MS);
  expect(signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("applies cancellable, silent reads to history windows, index pages and long-message content", async () => {
  vi.mocked(apiRequest).mockResolvedValue({});
  await agentRuntimeApi.historyWindow("a b", "older");
  await agentRuntimeApi.historyIndexPage("a b", "older");
  await agentRuntimeApi.messageContentPage("a b", "m", 8, 2);
  expect(vi.mocked(apiRequest).mock.calls.map(([url]) => url)).toEqual([
    "/api/agent-runtime/sessions/a%20b/history-window?cursor=older",
    "/api/agent-runtime/sessions/a%20b/history-window?view=timeline&cursor=older",
    "/api/agent-runtime/sessions/a%20b/messages/m/content?cursor=8&revision=2",
  ]);
  for (const [, options] of vi.mocked(apiRequest).mock.calls) {
    expect(options?.silent).toBe(true);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
});
