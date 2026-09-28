import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
import { SessionTimeGroups } from "../SessionTimeGroups";
import { ContextMenuProvider } from "../../../components/context-menu/ContextMenuProvider";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useSessionList } from "../useSessionList";

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "s1",
    projectId: "p1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "goal",
    status: "completed",
    title: null,
    prompt: "test",
    contextSnapshotId: null,
    thinkingMode: "standard",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...overrides,
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <ContextMenuProvider>{children}</ContextMenuProvider>
  </MemoryRouter>
);

describe("useSessionList", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      projectId: "p1",
      sessions: [],
      refreshSessions: vi.fn(async () => {}),
      sessionListTotal: 0,
    });
  });

  it("lists root sessions only and keeps the group count aligned", () => {
    const parent = makeSession({
      id: "parent",
      profileId: "goal",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const child = makeSession({
      id: "child",
      parentSessionId: "parent",
      profileId: "explorer",
      sessionMetadata: { mode: "plan" },
      updatedAt: "2026-01-03T00:00:00Z",
    });
    const older = makeSession({
      id: "older",
      profileId: "goal",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    useAgentSessionStore.setState({
      projectId: "p1",
      sessions: [older, parent, child],
    });

    const { result } = renderHook(
      () => useSessionList("zh", "sessions", "p1"),
      { wrapper },
    );

    const group = result.current.groups[0];
    expect(group.sessions.map((node) => node.session.id)).toEqual([
      "parent",
      "older",
    ]);
    expect(group.sessions).toHaveLength(group.count);
    expect(result.current.viewCounts.sessions).toBe(2);
  });
});

function List() {
  const list = useSessionList("zh", "sessions", "p1");
  return (
    <SessionTimeGroups
      groups={list.groups}
      selectedId={null}
      hideGroupHeaders={!list.hasPinned}
      isLoadingMore={false}
      hasMore={false}
      onSelect={list.select}
      onToggleGroup={list.toggleGroup}
      onToggleExpand={list.toggleExpand}
      onLoadMore={list.loadMore}
      onDelete={list.deleteSession}
      onTogglePin={list.togglePin}
    />
  );
}

describe("pinned session sections", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      projectId: "p1",
      sessionListTotal: 2,
      refreshSessions: vi.fn(async () => {}),
      sessions: [
        makeSession({ id: "new", title: "普通测试", updatedAt: "2026-01-03" }),
        makeSession({
          id: "old",
          title: "置顶测试",
          sessionMetadata: { pinned: true },
        }),
      ],
    });
  });

  it("keeps ordinary sessions open, collapses only pins, and hides headers after the last unpin", () => {
    const { container } = render(<List />, { wrapper });
    const headers = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".session-list-section-toggle",
        ),
      );
    expect(headers().map((button) => button.textContent)).toEqual([
      "置顶· 1",
    ]);
    expect(
      container.querySelectorAll(".session-list-section--separated"),
    ).toHaveLength(1);
    expect(container.querySelectorAll(".session-list-pin, .lucide-pin")).toHaveLength(0);
    const ordinaryLabel = container.querySelector(".session-list-section-label")!;
    expect(ordinaryLabel).toHaveTextContent("会话· 1");
    expect(ordinaryLabel.tagName).not.toBe("BUTTON");
    fireEvent.click(headers()[0]);
    expect(headers()[0].getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("普通测试")).toBeVisible();
    expect(
      document.getElementById(headers()[0].getAttribute("aria-controls")!),
    ).toHaveAttribute("inert");
    expect(screen.getByText("置顶测试")).toBeInTheDocument();
    fireEvent.click(ordinaryLabel);
    expect(screen.getByText("普通测试")).toBeVisible();
    expect(headers()[0]).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(headers()[0]);
    expect(headers()[0]).toHaveAttribute("aria-expanded", "true");
    act(() =>
      useAgentSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          sessionMetadata: { pinned: false },
        })),
      })),
    );
    expect(headers()).toHaveLength(0);
    expect(
      container.querySelector(".session-list-section--separated"),
    ).toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();
    expect(container.querySelectorAll(".session-list-item")).toHaveLength(2);
  });

  it("pins and unpins from the row menu without opening the session", async () => {
    const pin = vi
      .spyOn(agentRuntimeApi, "setSessionPinned")
      .mockImplementation(async (id, pinned) => ({
        session: makeSession({ id, sessionMetadata: { pinned } }),
      }));
    useAgentSessionStore.setState({ sessionListOffset: 40 });
    const { container } = render(<List />, { wrapper });
    try {
      const row = screen.getByText("普通测试").closest(".session-list-item")!;
      fireEvent.click(row.querySelector(".session-list-delete")!);
      await act(async () =>
        fireEvent.click(
          screen.getByRole("menuitem", { name: /^(置顶|取消置顶)$/ }),
        ),
      );
      expect(pin).toHaveBeenCalledWith("new", true);
      expect(useAgentSessionStore.getState().sessionListOffset).toBe(0);
      expect(container.querySelectorAll(".session-list-pin, .lucide-pin")).toHaveLength(0);
      expect(container.querySelector(".session-list-section-toggle")).toHaveTextContent("置顶· 2");
      const pinnedRow = screen
        .getByText("普通测试")
        .closest(".session-list-item")!;
      fireEvent.click(pinnedRow.querySelector(".session-list-delete")!);
      await act(async () =>
        fireEvent.click(
          screen.getByRole("menuitem", { name: /^(置顶|取消置顶)$/ }),
        ),
      );
      expect(pin).toHaveBeenLastCalledWith("new", false);
      expect(container.querySelectorAll(".session-list-pin, .lucide-pin")).toHaveLength(0);
      expect(container.querySelector(".session-list-section-toggle")).toHaveTextContent("置顶· 1");
      expect(
        useAgentSessionStore.getState().refreshSessions,
      ).toHaveBeenCalledTimes(2);
    } finally {
      pin.mockRestore();
    }
  });

  it("does not apply a pin when saving fails", async () => {
    const pin = vi
      .spyOn(agentRuntimeApi, "setSessionPinned")
      .mockRejectedValue(new Error("offline"));
    const { result } = renderHook(
      () => useSessionList("zh", "sessions", "p1"),
      { wrapper },
    );
    try {
      await expect(result.current.togglePin("new")).rejects.toThrow("offline");
      expect(
        result.current.groups[0].sessions.map((node) => node.session.id),
      ).toEqual(["old"]);
      expect(
        useAgentSessionStore.getState().refreshSessions,
      ).not.toHaveBeenCalled();
    } finally {
      pin.mockRestore();
    }
  });
});
