import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useAgentDockStore } from "../state/agentDockStore";
import { resetSessionComposerDrafts } from "../state/sessionComposerDraftStore";
import { useSessionComposerSelections } from "../useSessionComposerSelection";
import { SessionComposer } from "../SessionComposer";

vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
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
    providers: [{ id: "api", kind: "api" }],
    globalConfig: null,
    effectiveConfig: null,
  }),
}));
vi.mock("../composer/AgentComposer", () => ({
  AgentComposer: (props: {
    commands?: { header?: ReactNode; trigger?: ReactNode };
    modeControl?: ReactNode;
  }) => (
    <form>
      {props.modeControl}
      {props.commands?.header}
      {props.commands?.trigger}
      <textarea aria-label="Message" />
    </form>
  ),
}));
// The Git entries only need to expose the gate the composer hands them.
vi.mock("../git-actions/ComposerGitActions", () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      Commit
    </button>
  ),
}));
// The orchestration card only needs to expose where the composer mounts it.
vi.mock("../super-coding/SuperDagCard", () => ({
  SuperDagCard: () => <span>编排桩</span>,
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
  resetSessionComposerDrafts();
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

function renderComposer(props: {
  readingHistory?: boolean;
  session?: AgentSession;
  layout?: "footer" | "centered" | "focusRail";
}) {
  return render(
    <MemoryRouter>
      <SessionComposer
        session={props.session ?? session}
        projectId="p1"
        readingHistory={props.readingHistory}
        layout={props.layout}
      />
    </MemoryRouter>,
  );
}

describe("SessionComposer Git entries", () => {
  it("keeps the Git entries usable while the transcript is scrolled into history", () => {
    renderComposer({ readingHistory: true });
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
  });

  it("still refuses Git entries while a run owns the session", () => {
    renderComposer({ session: { ...session, activeRunId: "run-1" } });
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it.each(["footer", "centered", "focusRail"] as const)("keeps orchestration and Git outside the input on one row in %s", (layout) => {
    renderComposer({
      layout,
      session: { ...session, sessionMetadata: { mode: "super" } },
    });

    const commit = screen.getByRole("button", { name: "Commit" });
    const orchestration = screen.getByText("编排桩");
    const row = orchestration.parentElement;

    expect(row).toBe(commit.parentElement);
    expect(row?.className).toContain("flex");
    expect(row?.className).toContain("flex-wrap");
    expect(row).toHaveClass("agent-session-action-row");
    expect(row?.closest(".agent-session-composer-shell")).toBeNull();
    expect(row?.closest('[inert], [aria-hidden="true"]')).toBeNull();
  });
});
