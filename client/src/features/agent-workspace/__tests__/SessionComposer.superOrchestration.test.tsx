import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../adapters/transport/agentRuntime";
import { superCodingApi } from "../../../adapters/transport/super-coding";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useAgentDockStore } from "../state/agentDockStore";
import { resetSessionComposerDrafts } from "../state/sessionComposerDraftStore";
import { useSessionComposerSelections } from "../useSessionComposerSelection";
import { SessionComposer } from "../SessionComposer";
import type { SuperGraph } from "../../../../../packages/contracts/super-coding";

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
  AgentComposer: () => (
    <form>
      <textarea aria-label="Message" />
    </form>
  ),
}));
vi.mock("../git-actions/ComposerGitActions", () => ({
  default: () => <button type="button">Commit</button>,
}));
vi.mock("../../../adapters/transport/super-coding", () => ({
  superCodingApi: {
    getGraph: vi.fn(),
    getChannel: vi.fn(),
    sendCommand: vi.fn(),
  },
}));

const getGraph = vi.mocked(superCodingApi.getGraph);
const getChannel = vi.mocked(superCodingApi.getChannel);

const graph: SuperGraph = {
  id: "super:s1",
  sessionId: "s1",
  rev: 3,
  phase: "running",
  maxNodes: 8,
  maxConcurrent: 5,
  nodes: [
    {
      id: "impl",
      title: "实现",
      taskType: "implement",
      objective: "实现",
      deliverable: "改动",
      acceptance: [],
      scope: [],
      status: "running",
      depth: 0,
      model: "",
      effort: "high",
      childSessionId: null,
      messages: 0,
      summary: null,
      error: null,
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
    },
  ],
  edges: [],
  verifyNodeId: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

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
  sessionMetadata: { mode: "super" },
};

beforeEach(() => {
  resetSessionComposerDrafts();
  vi.restoreAllMocks();
  getGraph.mockReset();
  getChannel.mockReset();
  getGraph.mockResolvedValue({ graph });
  getChannel.mockResolvedValue({ items: [] });
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

describe("SessionComposer super orchestration entry", () => {
  it("opens the orchestration detail when the pill is clicked", async () => {
    render(
      <MemoryRouter>
        {/* The session page mounts the composer in the focus rail, whose root
            sets pointer-events:none; the entry must stay clickable there. */}
        <SessionComposer session={session} projectId="p1" layout="focusRail" />
      </MemoryRouter>,
    );

    const pill = await screen.findByRole("button", {
      name: /编排 · 1 节点 · 执行中/,
    });
    expect(pill.className).toContain("pointer-events-auto");
    fireEvent.click(pill);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "编排图" })).toBeTruthy(),
    );
    expect(screen.getByRole("region", { name: "编排图" }).className).toContain(
      "pointer-events-auto",
    );
    expect(screen.getByText("实现")).toBeTruthy();
  });
});
