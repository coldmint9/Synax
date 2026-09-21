import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCommandRail } from "../AgentCommandRail";
import { useAgentSessionStore } from "../state/agentSessionStore";
import type {
  AgentSession,
  PermissionDecision,
} from "../../../../lib/api/agentRuntime";
vi.mock("../SessionComposer", () => ({
  SessionComposer: () => <textarea aria-label="Draft" />,
}));
vi.mock("../SessionFileChangeIsland", () => ({
  SessionFileChangeIsland: () => null,
}));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reserves the actual approval-rail height and removes the inset once resolved", async () => {
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height: 320 }) as DOMRect,
  );
  const reply = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    sessions: [
      {
        id: "one",
        profileId: "planner",
        sessionMetadata: null,
      } as AgentSession,
    ],
    permissions: [
      {
        id: "p1",
        sessionId: "one",
        action: "ask",
        patterns: ["file.txt"],
        resolvedAt: null,
        metadata: {},
      } as PermissionDecision,
    ],
    replyPermission: reply,
  });
  const view = render(
    <div className="agent-page-shell">
      <div className="session-chat-scroll" />
      <AgentCommandRail
        sessionId="one"
        projectId="project"
        focus={false}
        insetLeft={0}
        insetRight={0}
      />
    </div>,
  );
  const page = view.container.firstElementChild as HTMLElement;
  expect(page.style.getPropertyValue("--agent-command-rail-height")).toBe(
    "332px",
  );
  expect(page.style.getPropertyValue("--agent-command-rail-max-height")).toBe(
    "576px",
  );
  await userEvent.click(screen.getByRole("button", { name: "permAllowOnce" }));
  expect(reply).toHaveBeenCalledWith("p1", "once");
  act(() => useAgentSessionStore.setState({ permissions: [] }));
  expect(page.style.getPropertyValue("--agent-command-rail-height")).toBe("");
  expect(disconnect).toHaveBeenCalled();
});

it("hides the composer for a workspace viewer without unmounting its input", () => {
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    sessions: [
      {
        id: "one",
        profileId: "synax",
        sessionMetadata: { source: "session-page", mode: "chat" },
      } as AgentSession,
    ],
  });
  const props = {
    sessionId: "one",
    projectId: "project",
    focus: false,
    insetLeft: 0,
    insetRight: 0,
    showFileSummary: false,
  };
  const view = render(<AgentCommandRail {...props} />);
  const input = screen.getByRole("textbox");
  view.rerender(<AgentCommandRail {...props} hidden />);
  expect(input.isConnected).toBe(true);
  expect(input.closest(".agent-command-rail")).toHaveAttribute("hidden");
  view.rerender(<AgentCommandRail {...props} />);
  expect(screen.getByRole("textbox")).toBe(input);
});
