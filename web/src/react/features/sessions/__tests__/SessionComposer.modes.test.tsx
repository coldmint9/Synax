import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { ComposerCommands } from "../../wiki/goal/GoalComposerPill";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../../lib/api/agentRuntime";
import { goalApi } from "../../../../lib/api/goal";
import { useAgentSessionStore } from "../agentSessionStore";
import { useWikiStore } from "../../../state/wikiStore";
import { useAcpDiscovery } from "../../wiki/goal/useAcpDiscovery";
import { SessionComposer } from "../SessionComposer";
import { SessionModeSummary } from "../SessionWorkspace";

vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../../lib/api/runtimeEventBus", () => ({
  subscribe: () => vi.fn(),
}));
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../../wiki/goal/useAcpDiscovery", () => ({
  useAcpDiscovery: vi.fn(),
}));
vi.mock("../../settings/useConfig", () => ({
  useConfig: () => ({
    providers: [
      { id: "api", kind: "api" },
      { id: "codex-acp", kind: "acp" },
    ],
    globalConfig: null,
    effectiveConfig: null,
  }),
}));
vi.mock("../../wiki/goal/GoalComposerPill", () => ({
  GoalComposerPill: (props: {
    commands?: ComposerCommands;
    modeControl?: ReactNode;
    content: string;
    onContentChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      {props.modeControl}
      {props.commands?.header}
      {props.commands?.trigger}
      <textarea
        ref={props.commands?.inputRef}
        aria-label="Message"
        value={props.content}
        disabled={props.disabled}
        onKeyDown={(event) => props.commands?.onKeyDown(event)}
        onChange={(event) => {
          props.onContentChange(event.target.value);
          props.commands?.onInput(
            event.target.value,
            event.target.selectionStart,
          );
        }}
      />
      <button type="submit" disabled={props.disabled}>
        Send
      </button>
    </form>
  ),
}));

const session: AgentSession = {
  id: "s1",
  projectId: "p1",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "synax",
  status: "completed",
  title: null,
  prompt: "Task",
  contextSnapshotId: null,
  thinkingMode: "standard",
  createdAt: "",
  updatedAt: "",
  completedAt: null,
  resultSummary: null,
  blockedReason: null,
  skillIds: [],
  activeRunId: null,
  pendingResumeToken: null,
  model: "test-model",
  sessionMetadata: { mode: "chat" },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useAcpDiscovery).mockReturnValue([
    {
      id: "codex-acp",
      label: "Codex ACP",
      command: "codex-acp",
      status: "available",
      installed: true,
      handshakeOk: true,
      selected: false,
      compatibility: "",
    },
  ]);
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    sessions: [session],
    selectedSessionId: "s1",
  });
  useWikiStore.setState({
    goalComposerProviderId: "api",
    goalComposerModelId: "test-model",
    goalComposerPermissionTier: "boundary",
    goalComposerReasoningEffort: "high",
    goalComposerWikiAttachMode: "auto",
    goalComposerDocumentId: null,
    documents: [],
    loadProjectSnapshot: vi.fn(async () => {}),
  });
  vi.spyOn(agentRuntimeApi, "listInteractions").mockResolvedValue({
    interactions: [],
  });
  vi.spyOn(agentRuntimeApi, "listInputQueue").mockResolvedValue({ items: [] });
  vi.spyOn(agentRuntimeApi, "listBackends").mockResolvedValue({ items: [] });
});

const renderComposer = (existing?: AgentSession) =>
  render(
    <MemoryRouter>
      <SessionComposer session={existing} projectId="p1" />
    </MemoryRouter>,
  );

async function selectMode(mode: "plan" | "goal", prefix = "") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: `${prefix}/${mode}` },
  });
  await userEvent.click(
    await screen.findByRole("option", { name: new RegExp(`^/${mode} `) }),
  );
}

async function expectModeUnavailable() {
  const trigger = screen.getByRole("button", { name: "Add context" });
  if ((trigger as HTMLButtonElement).disabled) {
    expect(trigger).toBeDisabled();
    return;
  }
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "/plan" },
  });
  expect(
    await screen.findByRole("option", { name: /^\/plan / }),
  ).toHaveAttribute("aria-disabled", "true");
}

describe("SessionComposer input queue", () => {
  const items = [
    {
      id: "queued-1",
      message: "First queued message",
      model: null,
      enqueuedAt: "",
    },
    {
      id: "queued-2",
      message: "Second queued message",
      model: null,
      enqueuedAt: "",
    },
  ];

  it.each(["footer", "centered", "focusRail"] as const)(
    "renders the queue above and outside the composer island in %s layout",
    async (layout) => {
      vi.mocked(agentRuntimeApi.listInputQueue).mockResolvedValue({ items });
      render(
        <MemoryRouter>
          <SessionComposer session={session} projectId="p1" layout={layout} />
        </MemoryRouter>,
      );

      const queue = (await screen.findByText(items[0].message)).closest(
        ".input-queue-strip",
      )!;
      const input = screen.getByRole("textbox", { name: "Message" });
      const island = input.closest(".session-composer-island")!;
      expect(island).toBeInTheDocument();
      expect(queue.parentElement).toBe(island.parentElement);
      expect(queue.nextElementSibling).toBe(island);
      expect(queue.closest(".goal-session-composer-shell")).toBeNull();
      expect(input.closest("form")).not.toContainElement(queue);
    },
  );

  it.each([false, true])(
    "preserves force and remove callbacks while readingHistory is %s",
    async (readingHistory) => {
      const force = vi.fn(async () => {});
      const remove = vi.fn(async () => {});
      useAgentSessionStore.setState({
        forceQueuedInput: force,
        removeQueuedInput: remove,
      });
      vi.mocked(agentRuntimeApi.listInputQueue).mockResolvedValue({ items });
      const { container } = render(
        <MemoryRouter>
          <SessionComposer
            session={{ ...session, status: "running" }}
            projectId="p1"
            readingHistory={readingHistory}
          />
        </MemoryRouter>,
      );

      const item = (await screen.findByText(items[1].message)).closest("li")!;
      const forceButton = within(item).getByRole("button", {
        name: "inputQueueForce",
      });
      expect(forceButton).toHaveAttribute("title", "inputQueueForce");
      expect(item.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(
        container.querySelector(".session-composer-island"),
      ).toHaveAttribute("data-collapsed", String(readingHistory));

      await userEvent.click(forceButton);
      expect(force).toHaveBeenCalledExactlyOnceWith(session.id, items[1].id);
      expect(remove).not.toHaveBeenCalled();

      await userEvent.click(
        within(item).getByRole("button", { name: "inputQueueRemove" }),
      );
      expect(remove).toHaveBeenCalledExactlyOnceWith(session.id, items[1].id);
      expect(force).toHaveBeenCalledTimes(1);
    },
  );
});

describe("SessionComposer mode controls", () => {
  it("lists only discovered ACP backends and reacts when discovery completes", async () => {
    const discovered = vi.mocked(useAcpDiscovery)();
    vi.mocked(useAcpDiscovery).mockReturnValue([]);
    const view = renderComposer();
    await userEvent.click(
      screen.getByRole("button", { name: "Execution backend" }),
    );
    expect(
      screen.queryByRole("option", { name: "codex-acp" }),
    ).not.toBeInTheDocument();
    vi.mocked(useAcpDiscovery).mockReturnValue(discovered);
    view.rerender(
      <MemoryRouter>
        <SessionComposer projectId="p1" />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("option", { name: "codex-acp" }),
    ).toBeInTheDocument();
  });

  it("blocks a remembered undiscovered ACP draft while allowing backend selection", async () => {
    vi.mocked(useAcpDiscovery).mockReturnValue([]);
    useWikiStore.setState({
      goalComposerProviderId: "codex-acp",
      goalComposerModelId: "default",
    });
    renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "has not discovered this ACP",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Execution backend" }),
    );
    expect(screen.getByRole("option", { name: "Synax" })).toBeEnabled();
    expect(
      screen.queryByRole("option", { name: "codex-acp" }),
    ).not.toBeInTheDocument();
  });

  it.each(["plan", "goal"] as const)(
    "sends the selected draft %s mode through createSession metadata",
    async (mode) => {
      vi.spyOn(goalApi, "buildSessionPrompt").mockResolvedValue({
        prompt: "Scaffold",
        wikiContext: { mode: "auto", documentId: null },
      } as never);
      vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue({
        session,
        context: null,
        profile: {} as never,
      });
      useAgentSessionStore.setState({
        sendSessionMessage: vi.fn(async () => {}),
      });
      renderComposer();
      await selectMode(mode);
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
        target: { value: "Build forms" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(agentRuntimeApi.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionMetadata: expect.objectContaining({
              mode,
              goalContent: "Build forms",
            }),
            permissionTier: "boundary",
          }),
        ),
      );
      expect(goalApi.buildSessionPrompt).not.toHaveBeenCalled();
    },
  );

  it("sends plain session input without hidden implementation scaffolding", async () => {
    const send = vi.fn(async () => {});
    vi.spyOn(goalApi, "buildSessionPrompt").mockResolvedValue({
      prompt: "你好",
      wikiContext: { mode: "auto", documentId: null },
    } as never);
    vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue({
      session,
      context: null,
      profile: {} as never,
    });
    useAgentSessionStore.setState({ sendSessionMessage: send });
    renderComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "你好" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ message: "你好", references: [] }),
      ),
    );
    expect(goalApi.buildSessionPrompt).not.toHaveBeenCalled();
  });

  it("disables ACP mode selection and sends ACP drafts as chat without discarding the native draft choice", async () => {
    useAgentSessionStore.setState({ draftMode: "plan" });
    useWikiStore.setState({
      goalComposerProviderId: "codex-acp",
      goalComposerModelId: "default",
    });
    renderComposer();
    await expectModeUnavailable();
    expect(
      screen.queryByRole("button", { name: "Session mode" }),
    ).not.toBeInTheDocument();
    expect(useAgentSessionStore.getState().draftMode).toBe("plan");
  });

  it("disables a live session’s mode selector, even when activeRunId is temporarily absent", async () => {
    renderComposer({ ...session, status: "running" });
    await waitFor(() =>
      expect(agentRuntimeApi.listInteractions).toHaveBeenCalled(),
    );
    await expectModeUnavailable();
  });

  it("disables mode and free-text input while a durable form is pending, even before the status patch arrives", async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({
      interactions: [
        {
          id: "i1",
          sessionId: "s1",
          runId: "r1",
          stepId: "step1",
          toolCallId: "tool1",
          revision: 1,
          kind: "clarification",
          status: "pending",
          response: null,
          createdAt: "",
          resolvedAt: null,
          request: {
            title: "Question",
            questions: [{ id: "q1", type: "text", label: "Answer" }],
          },
        },
      ],
    });
    renderComposer(session);
    await screen.findByRole("textbox", { name: "Answer" });
    await expectModeUnavailable();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Submit answers" }),
    ).toBeEnabled();
  });

  it("retains the existing mode and composer text when a safe idle switch is rejected by the server", async () => {
    vi.spyOn(agentRuntimeApi, "updateSessionMode").mockRejectedValue(
      new Error("Run started; mode is locked"),
    );
    renderComposer(session);
    await waitFor(() =>
      expect(agentRuntimeApi.listInteractions).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(useAgentSessionStore.getState().interactionState?.loading).toBe(
        false,
      ),
    );
    await selectMode("plan", "Keep my draft ");
    expect(await screen.findByRole("alert")).toHaveTextContent("Run started");
    expect(
      screen.queryByRole("button", { name: "Session mode" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep my draft /plan",
    );
  });

  it("keeps free-text input enabled when only a one-time plan approval is pending", async () => {
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValue({
      interactions: [
        {
          id: "plan1",
          sessionId: "s1",
          runId: "r1",
          stepId: "step1",
          toolCallId: "tool1",
          revision: 1,
          kind: "plan_approval",
          status: "pending",
          response: null,
          createdAt: "",
          resolvedAt: null,
          request: {
            title: "Approve plan",
            plan: {
              title: "Ship forms",
              objective: "Durable answers",
              steps: [
                {
                  id: "one",
                  title: "Implement",
                  description: "Build it",
                  dependsOn: [],
                  expectedFiles: [],
                },
              ],
              acceptanceCriteria: ["Tests pass"],
              assumptions: [],
              risks: [],
            },
          },
        },
      ],
    });
    renderComposer({ ...session, status: "waiting_input", activeRunId: "r1" });
    await screen.findByRole("button", { name: "Execute" });
    await expectModeUnavailable();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("renders the goal summary and specialist role without goal budgets", () => {
    const goalSession = {
      ...session,
      sessionMetadata: {
        mode: "goal" as const,
        goal: { objective: "Ship safely", status: "executing" as const },
        specialist: { name: "Reviewer", role: "Security review" },
      },
    };
    const { rerender } = render(<SessionModeSummary session={goalSession} />);
    expect(screen.getByRole("status")).toHaveTextContent("Executing");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(
      screen
        .getByText("Ship safely", { selector: "summary span" })
        .closest("summary")!,
    );
    expect(screen.getByText("Ship safely", { selector: "p" })).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Specialist: Reviewer")).toBeVisible();
    expect(screen.getByText("— Security review")).toBeVisible();
    act(() =>
      rerender(
        <SessionModeSummary
          session={{
            ...goalSession,
            sessionMetadata: {
              ...goalSession.sessionMetadata,
              goal: {
                ...goalSession.sessionMetadata.goal,
                status: "budget_exhausted",
                reason: "Legacy goal stop reason",
              },
            },
          }}
        />,
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Budget exhausted");
    expect(screen.getByText("Legacy goal stop reason")).toBeVisible();
  });
});

it("finishes an old draft in the background without navigating away or clearing the current conversation", async () => {
  let finish: (payload: any) => void = () => {};
  vi.spyOn(agentRuntimeApi, "createSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const send = vi.fn(async () => {});
  useAgentSessionStore.setState({
    projectId: "p1",
    sendSessionMessage: send,
    refreshSessions: vi.fn(async () => {}),
  });
  const other = { ...session, id: "other", title: "Other conversation" };
  function Harness() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <>
        <button
          onClick={() => {
            useAgentSessionStore.setState({ selectedSessionId: "other" });
            navigate("/projects/p1/sessions?session=other");
          }}
        >
          Open other conversation
        </button>
        <output data-testid="route">
          {location.pathname + location.search}
        </output>
        <SessionComposer
          projectId="p1"
          session={location.search.includes("other") ? other : undefined}
        />
      </>
    );
  }
  render(
    <MemoryRouter initialEntries={["/projects/p1/sessions/new"]}>
      <Harness />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "First request" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(agentRuntimeApi.createSession).toHaveBeenCalledTimes(1),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open other conversation" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Other unsent draft" },
  });
  await act(async () =>
    finish({
      session: { ...session, id: "late-created", title: "First request" },
      context: null,
      profile: {},
    }),
  );
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      "late-created",
      expect.objectContaining({ message: "First request" }),
    ),
  );
  expect(screen.getByTestId("route")).toHaveTextContent("session=other");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Other unsent draft",
  );
});
