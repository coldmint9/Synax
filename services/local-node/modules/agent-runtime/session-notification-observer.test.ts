import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  post: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("./sidecar/runtime-facade.js", () => ({
  runtimeFacade: { sessionSummaryAuthoritative: mocks.summary },
}));
vi.mock("../../infrastructure/runtime/parent-channel.js", () => ({
  postParentMessage: mocks.post,
}));
vi.mock("../../infrastructure/runtime/logger.js", () => ({
  logger: { warn: mocks.warn },
}));

import { runtimeBus } from "./runtime-bus.js";
import {
  SESSION_NOTIFICATION_MESSAGE,
  SessionNotificationObserver,
} from "./session-notification-observer.js";

const session = (patch: Record<string, unknown> = {}) => ({
  id: "s1",
  projectId: "p1",
  parentSessionId: null,
  status: "completed",
  title: "校验发票规则",
  completedAt: "2026-10-27T00:00:00Z",
  pendingResumeToken: null,
  resultSummary: "修改完成，测试通过。",
  blockedReason: null,
  ...patch,
});
const changed = (patch: Record<string, unknown>, sessionId = "s1") =>
  runtimeBus.emit({ type: "session_changed", sessionId, patch });
/** One macrotask so the authoritative lookup and delivery settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

let observer: SessionNotificationObserver;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.summary.mockResolvedValue(session());
  mocks.post.mockReturnValue(true);
  observer = new SessionNotificationObserver();
  observer.start();
});
afterEach(() => observer.stop());

it("publishes a ready-to-show notice while the desktop owns delivery", async () => {
  observer.configure({ desktop: true, locale: "en" });
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
    type: SESSION_NOTIFICATION_MESSAGE,
    payload: expect.objectContaining({
      id: "s1:completed:2026-10-27T00:00:00Z",
      projectId: "p1",
      sessionId: "s1",
      kind: "completed",
      title: "校验发票规则",
      body: "Session completed\n修改完成，测试通过。",
    }),
  });
});

it("uses the renderer's locale and deduplicates lifecycle echoes", async () => {
  observer.configure({ desktop: true });
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.post.mock.calls[0][0].payload.body).toContain("会话已完成");
});

it("notifies again when the same session settles a second run", async () => {
  observer.configure({ desktop: true });
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  changed({ status: "running" });
  mocks.summary.mockResolvedValue(
    session({ completedAt: "2026-10-27T01:00:00Z" }),
  );
  changed({ status: "completed", completedAt: "2026-10-27T01:00:00Z" });
  await settled();
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(mocks.post.mock.calls[1][0].payload.id).toBe(
    "s1:completed:2026-10-27T01:00:00Z",
  );
});

it("keeps settled children quiet but still interrupts for their questions", async () => {
  observer.configure({ desktop: true });
  mocks.summary.mockResolvedValue(session({ parentSessionId: "parent" }));
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.post).not.toHaveBeenCalled();
  mocks.summary.mockResolvedValue(
    session({
      parentSessionId: "parent",
      status: "waiting_input",
      pendingResumeToken: "request-1",
      completedAt: null,
    }),
  );
  changed({ status: "waiting_input", pendingResumeToken: "request-1" });
  await settled();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      payload: expect.objectContaining({ kind: "input" }),
    }),
  );
});

it("stays silent when a stale copy still reports the previous status", async () => {
  observer.configure({ desktop: true });
  mocks.summary.mockResolvedValue(session({ status: "running" }));
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it("delivers the newest episode when a transition lands during the lookup", async () => {
  observer.configure({ desktop: true });
  let release!: (value: unknown) => void;
  mocks.summary.mockImplementationOnce(
    () => new Promise((resolve) => (release = resolve)),
  );
  changed({ status: "waiting_input", pendingResumeToken: "q1" });
  await settled();
  // The run settles while the first snapshot is still loading.
  mocks.summary.mockResolvedValue(
    session({
      status: "completed",
      pendingResumeToken: null,
      completedAt: "2026-10-27T02:00:00Z",
    }),
  );
  changed({ status: "completed", completedAt: "2026-10-27T02:00:00Z" });
  release(
    session({ status: "waiting_input", pendingResumeToken: "q1", completedAt: null }),
  );
  await settled();
  await settled();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        id: "s1:completed:2026-10-27T02:00:00Z",
        kind: "completed",
      }),
    }),
  );
});

it("never replays an episode the window already showed after ownership moves", async () => {
  observer.configure({ desktop: false });
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.summary).not.toHaveBeenCalled();
  observer.configure({ desktop: true });
  // The same transition arriving again must not notify twice.
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it("logs and skips lookups that fail instead of breaking the bus", async () => {
  observer.configure({ desktop: true });
  mocks.summary.mockRejectedValue(new Error("Gone"));
  changed({ status: "completed", completedAt: "2026-10-27T00:00:00Z" });
  await settled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledOnce();
});
