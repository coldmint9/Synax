import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { workStore, type VerificationRecord } from "../work-store.js";
import { acceptedGoalReply, finishedRunReply } from "../goal-completion-reply.js";
import { GOAL_PREVIEW_MARKER } from "../visualization-integration.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";

const verification: VerificationRecord = {
  runId: "run_1",
  toolCallId: "call_1",
  criterion: "登录可用",
  purpose: "close",
  command: "npm test",
  workdir: "/workspace",
  scope: ["services"],
  fingerprint: "fp",
  changeVersion: 1,
  status: "success",
  startedAt: "2026-10-28T00:00:00.000Z",
  completedAt: "2026-10-28T00:01:00.000Z",
  external: false,
};

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
});

/** A root goal whose acceptance gate already persisted its facts. */
function acceptedGoal(result: string) {
  const session = agentSessionRuntime.create({
    projectId: "project-alpha",
    profileId: "synax",
    prompt: "实现登录接口",
    sessionMetadata: { mode: "goal" },
  });
  const work = workStore.create(session.id, "实现登录接口");
  work.acceptanceCriteria = ["登录可用", "错误提示可读"];
  work.changedPaths = ["src/login.ts", "src/login.test.ts"];
  work.verifications = [verification];
  work.evidence = [{ criterion: "登录可用", summary: "POST /login 返回 token" }];
  work.result = result;
  work.status = "completed";
  workStore.save(work);
  store.updateSessionMetadata(session.id, {
    plan: { status: "approved", revision: 1, acceptanceCriteria: work.acceptanceCriteria },
    goal: { objective: "实现登录接口", status: "completed", acceptanceEvidence: work.evidence },
  });
  return { session, work };
}

describe("acceptedGoalReply", () => {
  it("renders the acceptance report from the persisted goal and work facts", () => {
    const { session, work } = acceptedGoal("登录接口已实现并通过验收");

    const reply = acceptedGoalReply(session.id)!;

    // The loop's own disposition summary ("Goal completed with acceptance
    // evidence.") is not a report; the final reply must be the report.
    expect(reply.content.startsWith("目标已完成")).toBe(true);
    expect(reply.content).toContain("目标：实现登录接口");
    expect(reply.content).toContain("结论：登录接口已实现并通过验收");
    expect(reply.content).toContain("变更（2 个文件）：");
    expect(reply.content).toContain("- src/login.ts");
    expect(reply.content).toContain("验收标准（2 项）：");
    expect(reply.content).toContain("- 登录可用：POST /login 返回 token");
    expect(reply.content).toContain("验证（1 项）：");
    expect(reply.content).toContain("- ✔ `npm test`");
    expect(reply.content).toContain("未完成项：无");
    expect(reply.conclusion).toBe("登录接口已实现并通过验收");
    expect(reply.workId).toBe(work.id);
    expect(reply.evidence).toEqual(work.evidence);
  });

  it("reports only what the acceptance gate persisted", () => {
    const { session } = acceptedGoal("");

    const reply = acceptedGoalReply(session.id)!;

    expect(reply.conclusion).toBe("");
    expect(reply.content).toContain("结论：工作已完成。");
  });

  it("keeps an accepted preview behind the report instead of its declaration", () => {
    const { session } = acceptedGoal(
      "登录接口已实现并通过验收\n\n```synax-visualize\n<div>登录流程</div>\n```",
    );

    const reply = acceptedGoalReply(session.id)!;
    const marker = reply.content.indexOf(GOAL_PREVIEW_MARKER);

    expect(reply.content.startsWith("目标已完成")).toBe(true);
    expect(reply.content).not.toContain("synax-visualize");
    expect(reply.content).toContain("结论：登录接口已实现并通过验收");
    expect(marker).toBeGreaterThan(reply.content.indexOf("未完成项"));
    expect(reply.visualizations).toHaveLength(1);
    expect(reply.visualizations[0]).toMatchObject({ html: "<div>登录流程</div>", start: marker });
  });

  it("stays silent while the goal is not accepted", () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "实现登录接口",
      sessionMetadata: { mode: "goal" },
    });
    workStore.create(session.id, "实现登录接口");
    store.updateSessionMetadata(session.id, {
      goal: { objective: "实现登录接口", status: "executing" },
    });

    expect(acceptedGoalReply(session.id)).toBeNull();
  });
});

describe("finishedRunReply", () => {
  it("replaces the loop's disposition with the accepted report", () => {
    const { session, work } = acceptedGoal("登录接口已实现并通过验收");

    const reply = finishedRunReply({ sessionId: session.id, status: "completed",
      summary: "Goal completed with acceptance evidence.", text: "" });

    expect(reply.content.startsWith("目标已完成")).toBe(true);
    expect(reply.content).not.toContain("Goal completed with acceptance evidence.");
    expect(reply.resultSummary).toBe("登录接口已实现并通过验收");
    expect(reply.metadata).toMatchObject({ purpose: "work_result", goalStatus: "completed", goalFinalWorkId: work.id });
  });

  it("keeps the disposition for every other outcome", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Chat" });

    expect(finishedRunReply({ sessionId: session.id, status: "completed", summary: "Final response.", text: "draft" }))
      .toEqual({ content: "Final response.", resultSummary: "Final response.", metadata: {} });
    // A blocked goal is not an acceptance, even when the goal object exists.
    const { session: goalSession } = acceptedGoal("登录接口已实现并通过验收");
    expect(finishedRunReply({ sessionId: goalSession.id, status: "blocked", summary: "A required service is unavailable.", text: "" }))
      .toMatchObject({ content: "A required service is unavailable.", metadata: {} });
  });

  it("falls back to the model text when the loop published no summary", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Chat" });

    expect(finishedRunReply({ sessionId: session.id, status: "completed", summary: null, text: "Final response." }).content)
      .toBe("Final response.");
  });
});
