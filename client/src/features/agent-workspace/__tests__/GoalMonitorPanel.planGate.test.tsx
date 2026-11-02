import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, TodoItem } from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { GoalMonitorPanel } from "../GoalMonitorPanel";

vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));

const prompt = "Design a subagent-driven DAG super coding mode";

const plan = {
  title: "Ship the goal card",
  objective: "Show the real goal and staged acceptance",
  steps: [],
  acceptanceCriteria: ["Todos are staged", "Card shows progress"],
  humanAcceptanceCriteria: [],
  assumptions: [],
  risks: [],
  status: "approved",
  revision: 3,
};

const tasks = (done: number, total: number): TodoItem[] =>
  Array.from({ length: total }, (_, index) => ({
    id: `t${index}`,
    label: `Task ${index}`,
    status: index < done ? "done" : "pending",
  }));

const sessionWith = (metadata: Record<string, unknown>): AgentSession => ({
  id: "s1",
  projectId: "p1",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "goal",
  status: "running",
  title: null,
  prompt,
  contextSnapshotId: null,
  thinkingMode: "standard",
  createdAt: "",
  updatedAt: "",
  completedAt: null,
  resultSummary: null,
  blockedReason: null,
  skillIds: [],
  activeRunId: "r1",
  pendingResumeToken: null,
  model: null,
  sessionMetadata: metadata,
});

function mount(metadata: Record<string, unknown>, todos: TodoItem[] = []) {
  useAgentSessionStore.setState({
    sessions: [sessionWith(metadata)],
    selectedSessionId: "s1",
    sessionTodos: todos,
    interactionState: null,
  });
  return render(<GoalMonitorPanel sessionId="s1" />);
}

describe("goal monitor card", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      sessions: [],
      selectedSessionId: null,
      sessionTodos: [],
      interactionState: null,
    });
  });

  it("waits for a real goal instead of echoing the first user message", () => {
    const { container } = mount({
      mode: "goal",
      goal: { objective: prompt, status: "planning" },
    });
    expect(screen.queryByText(prompt)).toBeNull();
    expect(container.querySelector(".goal-monitor__skeleton")).not.toBeNull();
    expect(screen.getByText("Framing")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders the authored goal with staged acceptance", () => {
    mount(
      {
        mode: "goal",
        goal: {
          objective: prompt,
          status: "executing",
          acceptedCriteria: ["Todos are staged"],
        },
        plan,
      },
      tasks(2, 4),
    );
    expect(screen.getByText("Ship the goal card")).toBeInTheDocument();
    expect(screen.queryByText(prompt)).toBeNull();
    expect(screen.getByText("Executing")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "60",
    );
    expect(screen.getByText("Acceptance")).toBeInTheDocument();
    expect(screen.getByText("2/4")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("labels an unapproved plan as awaiting approval, not execution", () => {
    mount({
      mode: "goal",
      goal: { objective: prompt, status: "planning" },
      plan: { ...plan, status: "saved", revision: 1 },
    });
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.queryByText("Executing")).toBeNull();
  });
});
