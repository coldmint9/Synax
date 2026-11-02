import { afterEach, expect, it, vi } from "vitest";
import { agentRuntimeApi } from "../../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../agentSessionStore";
import { usePendingSubmissionStore } from "../pendingSubmissionStore";

vi.mock("../../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));

afterEach(() => {
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
  usePendingSubmissionStore.setState({ items: {} });
  vi.restoreAllMocks();
});

it("mounts composer-selected skills as per-turn references", async () => {
  const submit = vi.spyOn(agentRuntimeApi, "submitRun").mockResolvedValue({
    run: { id: "run-skill" } as never,
    reused: false,
  });
  useAgentSessionStore.setState({
    projectId: "p1",
    sessions: [],
    selectedSessionId: null,
    refreshSessions: vi.fn(async () => {}),
    refreshDetail: vi.fn(async () => {}),
  });

  await useAgentSessionStore.getState().sendSessionMessage("session-a", {
    message: "Review this change",
    references: [{ kind: "file", id: "src/a.ts" }],
    skillIds: ["synax-builtin/code-review", "synax-builtin/code-review"],
  });

  const [, body] = submit.mock.calls[0]!;
  expect(body.references).toEqual([
    { kind: "file", id: "src/a.ts" },
    { kind: "skill", id: "synax-builtin/code-review" },
  ]);
});
