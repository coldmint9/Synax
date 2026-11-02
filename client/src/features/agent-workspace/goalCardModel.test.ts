import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../adapters/transport/agentRuntime";
import {
  buildGoalProgress,
  hasAuthoredGoal,
  statusFor,
} from "./goalCardModel";

const plan = {
  title: "Ship the goal card",
  objective: "Show the real goal and staged acceptance",
  acceptanceCriteria: ["A", "B", "C", "D"],
  status: "approved",
  revision: 2,
};

const tasks = (done: number, total: number): TodoItem[] =>
  Array.from({ length: total }, (_, index) => ({
    id: `t${index}`,
    label: `Task ${index}`,
    status: index < done ? "done" : index === done ? "in_progress" : "pending",
  }));

describe("goal monitor status", () => {
  it("shows paused for an executing goal after its run is interrupted", () => {
    expect(
      statusFor({ status: "interrupted" }, { status: "executing" }, false),
    ).toBe("paused");
  });

  it("shows completed only when acceptance evidence exists", () => {
    expect(
      statusFor(
        { status: "completed" },
        { status: "completed", acceptanceEvidence: [{}] },
        false,
      ),
    ).toBe("completed");
    expect(
      statusFor({ status: "completed" }, { status: "completed" }, false),
    ).toBe("planning");
  });

  it("does not report execution before the plan is approved", () => {
    expect(
      statusFor({ status: "running" }, { status: "planning" }, false, {
        status: "draft",
      }),
    ).toBe("planning");
    expect(
      statusFor({ status: "running" }, { status: "executing" }, false, plan),
    ).toBe("executing");
  });
});

describe("goal monitor progress", () => {
  it("reports no goal before the first plan exists", () => {
    const progress = buildGoalProgress({
      goal: { objective: "The raw first user message", status: "planning" },
      plan: null,
      todos: [],
      completed: false,
    });
    expect(hasAuthoredGoal(null)).toBe(false);
    expect(progress.percent).toBe(0);
    expect(progress.criteria).toEqual([]);
    expect(progress.stages.map((stage) => stage.state)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("counts a proposed plan as a stage instead of jumping to zero", () => {
    const progress = buildGoalProgress({
      goal: { status: "planning" },
      plan: { ...plan, status: "draft" },
      todos: [],
      completed: false,
    });
    // The goal stage is done, approval and acceptance are still open.
    expect(progress.percent).toBe(10);
    expect(progress.stages[1].state).toBe("active");
  });

  it("moves through execution and per-criterion acceptance", () => {
    const early = buildGoalProgress({
      goal: { status: "executing" },
      plan,
      todos: tasks(1, 4),
      completed: false,
    });
    const later = buildGoalProgress({
      goal: { status: "executing", acceptedCriteria: ["A", "B"] },
      plan,
      todos: tasks(4, 4),
      completed: false,
    });
    expect(early.percent).toBe(29);
    expect(later.percent).toBe(78);
    expect(later.acceptedCount).toBe(2);
    expect(later.criteria.filter((item) => item.accepted)).toHaveLength(2);
  });

  it("accepts criteria attested by evidence as well as acceptedCriteria", () => {
    const progress = buildGoalProgress({
      goal: {
        status: "executing",
        acceptanceEvidence: [{ criterion: "C" }],
      },
      plan,
      todos: tasks(4, 4),
      completed: false,
    });
    expect(progress.acceptedCount).toBe(1);
    expect(progress.criteria.map((item) => item.accepted)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("drops the execution stage when the run keeps no task list", () => {
    const progress = buildGoalProgress({
      goal: { status: "executing", acceptedCriteria: ["A"] },
      plan,
      todos: [],
      completed: false,
    });
    const execute = progress.stages.find((stage) => stage.id === "execute");
    expect(execute?.total).toBeNull();
    expect(execute?.weight).toBe(0);
    // Without a task list the execution share stays uncredited: 10 + 10 + 11.25.
    expect(progress.percent).toBe(31);
  });

  it("reports completion only at full acceptance", () => {
    const progress = buildGoalProgress({
      goal: { status: "executing", acceptedCriteria: ["A", "B", "C", "D"] },
      plan,
      todos: tasks(4, 4),
      completed: true,
    });
    expect(progress.percent).toBe(100);
    expect(progress.stages.every((stage) => stage.state === "done")).toBe(true);
  });
});
