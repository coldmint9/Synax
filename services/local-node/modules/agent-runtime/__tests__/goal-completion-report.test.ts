import { describe, expect, it } from "vitest";
import {
  buildGoalCompletionReport,
  type GoalCompletionReportInput,
} from "../goal-completion-report.js";

const verification = {
  runId: "run_1",
  toolCallId: "call_1",
  criterion: "tests pass",
  purpose: "close",
  command: "npm test",
  workdir: "/workspace",
  scope: ["services"],
  fingerprint: "fp",
  changeVersion: 1,
  status: "success" as const,
  startedAt: "2026-10-28T00:00:00.000Z",
  completedAt: "2026-10-28T00:01:00.000Z",
  external: false,
};

function report(overrides: Partial<GoalCompletionReportInput> = {}): string {
  return buildGoalCompletionReport({
    conclusion: "登录接口已实现并通过验收",
    objective: "实现登录接口",
    locale: "zh",
    ...overrides,
  });
}

describe("buildGoalCompletionReport", () => {
  it("renders the accepted objective, changes, criteria, verification and residual work", () => {
    const content = report({
      criteria: ["登录可用", "错误提示可读"],
      evidence: [{ criterion: "登录可用", summary: "POST /login 返回 token" }],
      changedPaths: ["src/login.ts", "src/login.test.ts", "src/login.ts"],
      verifications: [verification],
      remaining: [],
    });

    expect(content.startsWith("目标已完成")).toBe(true);
    expect(content).toContain("目标：实现登录接口");
    expect(content).toContain("结论：登录接口已实现并通过验收");
    expect(content).toContain("变更（2 个文件）：");
    expect(content).toContain("- src/login.ts");
    expect(content).toContain("验收标准（2 项）：");
    expect(content).toContain("- 登录可用：POST /login 返回 token");
    expect(content).toContain("- 错误提示可读");
    expect(content).toContain("验证（1 项）：");
    expect(content).toContain("- ✔ `npm test`");
    expect(content).toContain("未完成项：无");
  });

  it("never claims there is no residual work when the runtime reports some", () => {
    const content = report({
      criteria: ["登录可用"],
      evidence: [{ criterion: "登录可用", summary: "已通过" }],
      remaining: ["未补充多语言文案"],
    });

    expect(content).toContain("未完成项：");
    expect(content).toContain("- 未补充多语言文案");
    expect(content).not.toContain("未完成项：无");
  });

  it("falls back to server acceptance when no criteria or evidence were recorded", () => {
    const content = report();

    expect(content).toContain("验收标准：服务端验收证据已通过。");
    expect(content).not.toContain("变更（");
    expect(content).not.toContain("验证（");
  });

  it("renders an English report for English objectives", () => {
    const content = buildGoalCompletionReport({
      conclusion: "Login endpoint implemented",
      objective: "Implement login endpoint",
      criteria: ["Login works"],
      evidence: [{ criterion: "Login works", summary: "Token returned" }],
    });

    expect(content.startsWith("Goal completed")).toBe(true);
    expect(content).toContain("Objective: Implement login endpoint");
    expect(content).toContain("Acceptance criteria (1):");
    expect(content).toContain("Unfinished: none");
  });

  it("lists failed verification honestly", () => {
    const content = report({
      criteria: ["登录可用"],
      evidence: [{ criterion: "登录可用", summary: "已通过" }],
      verifications: [{ ...verification, status: "failed" }],
    });

    expect(content).toContain("- ✘ `npm test`");
  });
});
