import { resetSessionComposerDrafts } from "../state/sessionComposerDraftStore";
import { mediaDraftItems } from "../../media/useMediaDraft";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { ComposerCommands } from "../composer/AgentComposer";
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
} from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useAgentDockStore } from "../state/agentDockStore";
import { SessionComposer } from "../SessionComposer";
import { ConversationController } from "../state/conversationController";
import { InteractionSessionProvider } from "../AgentInteractionPanel";
import { SessionModeSummary } from "../SessionWorkspace";
import { useSessionComposerSelections } from "../useSessionComposerSelection";
import type { QuickAction } from "../../quick-actions/quickActions";

const testLocale = vi.hoisted(() => ({ value: "en" }));
vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: testLocale.value, t: (key: string) => key }),
}));
vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: () => vi.fn(),
}));
vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
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
vi.mock("../composer/AgentComposer", () => ({
  AgentComposer: (props: {
    commands?: ComposerCommands;
    modeControl?: ReactNode;
    content: string;
    placeholder?: string;
    quickActions?: readonly QuickAction[];
    onQuickActionSelect?: (action: QuickAction) => void;
    onContentChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
    submitting: boolean;
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
        placeholder={props.placeholder}
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
      {props.quickActions?.some((action) => action.kind === "launch" && action.policy === "compose") ? (
        <button type="button" onClick={() => {
          const action = props.quickActions!.find(
            (item) => item.kind === "launch" && item.policy === "compose",
          );
          if (action) props.onQuickActionSelect?.(action);
        }}>
          Attach quick action
        </button>
      ) : null}
      {props.quickActions?.[0] ? (
        <button type="button" onClick={() => props.onQuickActionSelect?.(props.quickActions![0]!)}>
          Run quick action
        </button>
      ) : null}
      <button type="submit" disabled={props.disabled} aria-busy={props.submitting}>
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
  testLocale.value = "en";
  resetSessionComposerDrafts();
  mediaDraftItems.reset();
  vi.restoreAllMocks();
  useSessionComposerSelections.setState({
    selections: {},
    lastSubmittedByProject: {},
  });
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    sessions: [session],
    selectedSessionId: "s1",
  });
  useAgentDockStore.setState({
    composerProviderId: "api",
    composerModelId: "test-model",
    composerPermissionTier: "boundary",
    composerReasoningEffort: "high",
    composerDocumentId: null,
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

it("starts a session from a home shortcut with its skill stack and keeps typed text as context", async () => {
  const user = userEvent.setup();
  const created = { ...session, id: "new-session", status: "running" as const };
  const submit = vi.fn().mockResolvedValue(created);
  const send = vi.fn().mockResolvedValue(undefined);
  useAgentSessionStore.setState({ submitSessionDraft: submit, sendSessionMessage: send });
  const { container } = render(<MemoryRouter><SessionComposer projectId="p1" layout="centered" /></MemoryRouter>);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Keep my notes" } });
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(screen.getByRole("button", { name: /Explore project/ }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("new-session", expect.objectContaining({
    message: expect.stringContaining("Keep my notes"),
  })));
  const [, body] = submit.mock.calls[0]!;
  expect(body.skillIds).toEqual(["synax-builtin/project-onboarding", "synax-builtin/visualize"]);
  expect(body.mode).toBe("chat");
  expect(body.prompt).toContain("## Additional context\n\nKeep my notes");
  expect(body.prompt).toContain("Treat this session as project onboarding");
  expect(container.querySelector(".home-feature-panel")!.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Task board/ })).not.toBeInTheDocument();
});

it("attaches a shortcut that needs input, waits for the details and then sends the procedure", async () => {
  const user = userEvent.setup();
  const created = { ...session, id: "new-compose", status: "running" as const };
  const submit = vi.fn().mockResolvedValue(created);
  const send = vi.fn().mockResolvedValue(undefined);
  useAgentSessionStore.setState({ submitSessionDraft: submit, sendSessionMessage: send });
  render(<MemoryRouter><SessionComposer projectId="p1" layout="centered" /></MemoryRouter>);

  await user.click(screen.getByRole("button", { name: /Investigate a bug/ }));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /Remove quick action: Investigate a bug/ })).toBeInTheDocument();
  const input = screen.getByRole("textbox", { name: "Message" });
  expect(input).toHaveAttribute("placeholder", "Describe the symptom, then the steps to reproduce and expected behavior…");

  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/Add observed behavior/);

  fireEvent.change(input, { target: { value: "Crash when saving" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const [, body] = submit.mock.calls[0]!;
  expect(body.skillIds).toEqual([
    "synax-builtin/systematic-debugging",
    "synax-builtin/synax-explore",
  ]);
  expect(body.prompt).toContain("Crash when saving");
  expect(body.prompt).toContain("Investigate the issue below");
  expect(body.mode).toBe("chat");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Remove quick action/ })).not.toBeInTheDocument(),
  );
});

it("dismisses an attached shortcut without touching typed text", async () => {
  const user = userEvent.setup();
  const created = { ...session, id: "new-dismiss", status: "running" as const };
  const submit = vi.fn().mockResolvedValue(created);
  useAgentSessionStore.setState({ submitSessionDraft: submit, sendSessionMessage: vi.fn().mockResolvedValue(undefined) });
  render(<MemoryRouter><SessionComposer projectId="p1" layout="centered" /></MemoryRouter>);

  await user.click(screen.getByRole("button", { name: /Investigate a bug/ }));
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Keep this" } });
  await user.click(screen.getByRole("button", { name: /Remove quick action: Investigate a bug/ }));

  expect(screen.queryByRole("button", { name: /Remove quick action/ })).not.toBeInTheDocument();
  expect(input).toHaveValue("Keep this");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const [, body] = submit.mock.calls[0]!;
  expect(body.prompt).toBe("Keep this");
  expect(body.skillIds).toBeUndefined();
});

it("switches to another shortcut by replacing the attachment instead of sending", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  useAgentSessionStore.setState({ submitSessionDraft: submit });
  render(<MemoryRouter><SessionComposer projectId="p1" layout="centered" /></MemoryRouter>);

  await user.click(screen.getByRole("button", { name: /Investigate a bug/ }));
  await user.click(screen.getByRole("button", { name: /Review changes/ }));

  expect(submit).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Remove quick action: Investigate a bug/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Remove quick action: Review changes/ })).toBeInTheDocument();
});

it("attaches a plus-menu shortcut that needs input instead of sending it immediately", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  useAgentSessionStore.setState({ submitSessionDraft: submit });
  render(<MemoryRouter><SessionComposer projectId="p1" layout="centered" /></MemoryRouter>);

  await user.click(screen.getByRole("button", { name: "Attach quick action" }));

  expect(submit).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: /Remove quick action: Plan a feature/ }),
  ).toBeInTheDocument();
});

it("runs a no-input plus-menu shortcut immediately", async () => {
  const user = userEvent.setup();
  const created = { ...session, id: "new-plus", status: "running" as const };
  const submit = vi.fn().mockResolvedValue(created);
  const send = vi.fn().mockResolvedValue(undefined);
  useAgentSessionStore.setState({ submitSessionDraft: submit, sendSessionMessage: send });
  render(<MemoryRouter><SessionComposer projectId="p1" layout="centered" /></MemoryRouter>);

  await user.click(screen.getByRole("button", { name: "Run quick action" }));

  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const [, body] = submit.mock.calls[0]!;
  expect(body.skillIds).toEqual(["synax-builtin/project-onboarding", "synax-builtin/visualize"]);
  expect(body.prompt).toContain("Treat this session as project onboarding");
  expect(screen.queryByRole("button", { name: /Remove quick action/ })).not.toBeInTheDocument();
});

it("keeps the interaction panel mounted when its state refreshes beside the input queue", async () => {
  const original = useAgentSessionStore.getState().refreshInteractions;
  const refresh = vi.fn((id: string) => {
    // Fail promptly if duplicate sibling keys cause a remount/refresh loop.
    if (refresh.mock.calls.length > 5)
      throw new Error("Interaction panel remounted repeatedly");
    return original(id);
  });
  useAgentSessionStore.setState({ refreshInteractions: refresh });
  const consoleError = vi.spyOn(console, "error");
  renderComposer(session);
  await waitFor(() =>
    expect(useAgentSessionStore.getState().interactionState?.loading).toBe(
      false,
    ),
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await refresh(session.id);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
});

it("keeps the direct mode selector and plus-menu mode controls synchronized", async () => {
  const { container } = renderComposer();
  const controls = container.querySelector(".agent-session-controls")!;
  const modeFrame = () => container.querySelector("[data-composer-mode-frame]");
  expect(controls).toHaveAttribute("data-composer-mode", "chat");
  expect(modeFrame()).toBeNull();
  expect(screen.queryByRole("img", { name: "Goal mode" })).not.toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Super mode" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Session mode" }),
  ).not.toBeInTheDocument();
  for (const [label, mode] of [
    ["Goal Beta", "goal"],
    ["Super Beta", "super"],
    ["Auto", "chat"],
  ] as const) {
    await userEvent.click(
      screen.getByRole("button", {
        name: "Add attachments, context or change mode",
      }),
    );
    if (mode === "super") {
      expect(screen.getByRole("radio", { name: "Super Beta", exact: true }).querySelector(".lucide-zap"))
        .toHaveAttribute("aria-hidden", "true");
    }
    await userEvent.click(
      screen.getByRole("radio", { name: label, exact: true }),
    );
    await waitFor(() =>
      expect(controls).toHaveAttribute("data-composer-mode", mode),
    );
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    if (mode === "chat") {
      // Chat stays quiet: no mode frame.
      expect(modeFrame()).toBeNull();
      expect(
        screen.queryByRole("img", { name: "Goal mode" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("img", { name: "Super mode" }),
      ).not.toBeInTheDocument();
      continue;
    }
    expect(modeFrame()).toBeNull();
    expect(
      screen.getByRole("img", { name: mode === "goal" ? "Goal mode" : "Super mode" }),
    ).toBeInTheDocument();
    if (mode === "super") {
      expect(screen.getByRole("img", { name: "Super mode" }).querySelector(".lucide-zap"))
        .toHaveAttribute("aria-hidden", "true");
    }
  }
});

it("keeps the draft and send loading state without a temporary message, and recovers on failure", async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(agentRuntimeApi, "createSession").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  renderComposer();
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Keep my message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(screen.getByText("Keep my message")).toBeVisible();
  expect(input).toHaveValue("Keep my message");
  expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Conversation history")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-busy", "true");
  expect(input).toBeDisabled();
  await act(async () => reject(new Error("Creation failed")));
  expect(input).toHaveValue("Keep my message");
  expect(input).toBeEnabled();
  expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-busy", "false");
  expect(await screen.findByRole("alert")).toHaveTextContent("Creation failed");
  expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
});

it("keeps loading until the first send succeeds, then enters the conversation", async () => {
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue({
    session,
    context: null,
    profile: {} as never,
  });
  useAgentSessionStore.setState({ sendSessionMessage: send });
  function Harness() {
    const location = useLocation();
    return (
      <>
        <output data-testid="route">{location.pathname}{location.search}</output>
        <output data-testid="entry">{String(location.state?.fromNewSession ?? false)}</output>
        <SessionComposer projectId="p1" />
      </>
    );
  }
  render(<MemoryRouter initialEntries={["/projects/p1/sessions/new"]}><Harness /></MemoryRouter>);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "First message" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("route")).toHaveTextContent("/sessions/new");
  expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByLabelText("Conversation history")).not.toBeInTheDocument();
  await act(async () => finish());
  await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("session=s1"));
  expect(screen.getByTestId("entry")).toHaveTextContent("true");
});

async function selectMode(mode: "goal", prefix = "") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: `${prefix}/${mode}` },
  });
  await userEvent.click(
    await screen.findByRole("option", { name: new RegExp(`^/${mode} `) }),
  );
}

async function expectModeUnavailable() {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add attachments, context or change mode"]',
  );
  if (!trigger) {
    expect(document.querySelector('[data-ask-active="true"]')).not.toBeNull();
    return;
  }
  if (trigger.disabled) {
    expect(trigger).toBeDisabled();
    return;
  }
  await userEvent.click(trigger);
  const goal = screen.queryByRole("radio", { name: "Goal Beta", exact: true });
  if (goal) expect(goal).toHaveAttribute("aria-disabled", "true");
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
    "renders the queue above the composer in %s layout",
    async (layout) => {
      vi.mocked(agentRuntimeApi.listInputQueue).mockResolvedValue({ items });
      const { container } = render(
        <MemoryRouter>
          <SessionComposer session={session} projectId="p1" layout={layout} />
        </MemoryRouter>,
      );

      const queue = (await screen.findByText(items[0].message)).closest(
        ".input-queue-strip",
      )!;
      const input = screen.getByRole("textbox", { name: "Message" });
      const composer = input.closest(".agent-session-composer-shell")!;
      const rail = container.querySelector(".agent-session-composer-rail")!;
      expect(composer).toBeInTheDocument();
      // The queue stays directly above the composer and outside its input box.
      expect(queue.parentElement).toBe(rail.parentElement?.parentElement);
      expect(queue.nextElementSibling).toBe(rail.parentElement);
      expect(rail).toContainElement(composer);
      expect(queue.closest(".agent-session-composer-shell")).toBeNull();
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
      expect(container.querySelector(".session-composer-island")).toBeNull();

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
  it.each([
    ["zh", "Close or stop the current orchestration before switching mode.", "请先结束或停止当前编排，再切换模式。"],
    ["en", "Close or stop the current orchestration before switching mode.", "Close or stop the current orchestration before switching mode."],
    ["zh", "Unknown failure: request=abc123", "Unknown failure: request=abc123"],
    ["en", "Unknown failure: request=abc123", "Unknown failure: request=abc123"],
  ])("presents %s mode errors without changing the draft or mode: %s", async (locale, message, expected) => {
    testLocale.value = locale;
    const update = vi.spyOn(agentRuntimeApi, "updateSessionMode").mockRejectedValue(new Error(message));
    const { container } = renderComposer(session);
    await waitFor(() => expect(useAgentSessionStore.getState().interactionState?.loading).toBe(false));
    await selectMode("goal", "Keep my draft ");
    await waitFor(() => expect(container.querySelector(".agent-composer-notice")).toHaveTextContent(expected));
    expect(update).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".agent-composer-notice")).toHaveAttribute("role", "alert");
    expect(container.querySelector(".agent-session-controls")).toHaveAttribute("data-composer-mode", "chat");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep my draft /goal");
  });

  it("no longer offers an execution backend selector for new sessions", async () => {
      renderComposer();
    expect(
      screen.queryByRole("button", { name: "Execution backend" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "codex-acp" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "native" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a remembered ACP provider now that drafts run on the native runtime", async () => {
      useAgentDockStore.setState({
      composerProviderId: "codex-acp",
      composerModelId: "default",
    });
    renderComposer();
    expect(
      screen.queryByRole("button", { name: "Execution backend" }),
    ).not.toBeInTheDocument();
    // The remembered ACP provider no longer picks a backend; it now surfaces as
    // an incompatible model for the native draft.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a model for this backend",
    );
  });

  it.each(["goal"] as const)(
    "sends the selected draft %s mode through createSession metadata",
    async (mode) => {
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
              userPrompt: "Build forms",
            }),
            permissionTier: "boundary",
          }),
        ),
      );
    },
  );

  it("sends plain session input without hidden implementation scaffolding", async () => {
    const send = vi.fn(async () => {});
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
    expect(
      useSessionComposerSelections.getState().lastSubmittedByProject.p1,
    ).toMatchObject({
      backendId: "native",
      providerId: "api",
      modelId: "test-model",
      reasoningEffort: "high",
    });
  });

  it("keeps the draft mode selectable when the remembered provider is an ACP engine", async () => {
    useAgentSessionStore.setState({ draftMode: "plan" });
    useAgentDockStore.setState({
      composerProviderId: "codex-acp",
      composerModelId: "default",
    });
    renderComposer();
    expect(useAgentSessionStore.getState().draftMode).toBe("plan");
    expect(
      screen.queryByRole("button", { name: "Execution backend" }),
    ).not.toBeInTheDocument();
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
    const { container } = renderComposer(session);
    await screen.findByRole("textbox", { name: "Answer" });
    await expectModeUnavailable();
    expect(container.querySelector('[data-ask-active="true"]')).not.toBeNull();
    expect(
      container.querySelector(".agent-composer-input-slot"),
    ).toHaveAttribute("inert");
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
    await selectMode("goal", "Keep my draft ");
    expect(await screen.findByRole("alert")).toHaveTextContent("Run started");
    expect(
      screen.getByRole("button", {
        name: "Add attachments, context or change mode",
      }),
    ).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep my draft /goal",
    );
  });

  it.each(["completed", "waiting_input"] as const)("replaces free-text input with the plan approval card while status is %s", async (status) => {
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
    const send = vi.fn(async () => {});
    useAgentSessionStore.setState({ submitOrEnqueueSessionInput: send });
    const { container } = renderComposer({ ...session, status, activeRunId: status === "waiting_input" ? "r1" : null });
    const execute = await screen.findByRole("button", { name: "Start execution" });
    expect(execute.closest(".agent-composer-ask-slot")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Plan ready for review" })).not.toBeInTheDocument();
    await expectModeUnavailable();
    expect(container.querySelector('[data-ask-active="true"]')).not.toBeNull();
    expect(container.querySelector(".agent-composer-input-slot")).toHaveAttribute("inert");
    const input = screen.getByRole("textbox", { name: "Message", hidden: true });
    expect(input).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Do not submit as a new turn" } });
    fireEvent.submit(input.closest("form")!);
    expect(send).not.toHaveBeenCalled();

    act(() => useAgentSessionStore.setState({
      interactionState: {
        ...useAgentSessionStore.getState().interactionState!,
        items: [],
      },
    }));
    if (status === "completed") {
      expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    }
    expect(input).toHaveValue("Do not submit as a new turn");
  });

  it.each(["chat"] as const)(
    "does not mount stale goal summaries in %s",
    (mode) => {
      const { container } = render(
        <SessionModeSummary
          session={{
            ...session,
            sessionMetadata: {
              mode,
              goal: {
                objective: "Historical goal",
                status: "blocked",
                reason: "Old blocker",
              },
            },
          }}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("renders the goal summary and specialist role without goal budgets", () => {
    const summarySession = {
      ...session,
      sessionMetadata: {
        mode: "goal" as const,
        goal: { objective: "Ship safely", status: "executing" as const },
        specialist: { name: "Reviewer", role: "Security review" },
      },
    };
    const { rerender } = render(
      <SessionModeSummary session={summarySession} />,
    );
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
            ...summarySession,
            sessionMetadata: {
              ...summarySession.sessionMetadata,
              goal: {
                ...summarySession.sessionMetadata.goal,
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
  expect(screen.getByText("First request")).toBeVisible();
  expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("First request");
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

it.each(["codex", "codex-acp", "claude-code"])("prevents submission for the retired %s backend while preserving history", async id => {
  const retired = { ...session, sessionMetadata: { backend: { id } } } as AgentSession;
  renderComposer(retired);
  expect(screen.getByRole("alert")).toHaveTextContent("execution backend has been removed");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /Native model|原生模型/ })).not.toBeInTheDocument();
});


it("sends from the child composer while the parent stays selected and unmodified", async () => {
  const child: AgentSession = { ...session, id: "side-child", parentSessionId: session.id,
    sessionMetadata: { mode: "chat", subagentKind: "side-chat" } };
  const controller = new ConversationController(child.id);
  controller.seedSession(child);
  vi.spyOn(controller, "refresh").mockResolvedValue();
  const submit = vi.spyOn(agentRuntimeApi, "submitRun").mockResolvedValue({
    run: { id: "child-run", sessionId: child.id, status: "queued" } as never, reused: false,
  });
  const refreshList = vi.fn(async () => {});
  useAgentSessionStore.setState({ refreshSessions: refreshList });
  render(<MemoryRouter><InteractionSessionProvider controller={controller}>
    <SessionComposer session={child} projectId="p1" scopedConversation={controller} />
  </InteractionSessionProvider></MemoryRouter>);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Remember our earlier decision?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith(child.id,
    expect.objectContaining({ message: "Remember our earlier decision?" }), expect.any(String), "continue"));
  expect(refreshList).not.toHaveBeenCalled();
  expect(useAgentSessionStore.getState().selectedSessionId).toBe(session.id);
  expect(useAgentSessionStore.getState().sessions).toEqual([session]);
});
