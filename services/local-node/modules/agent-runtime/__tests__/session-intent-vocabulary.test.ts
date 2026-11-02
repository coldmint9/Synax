import { beforeEach, describe, expect, it } from "vitest";
import {
  listWorkspaceIntentLabels,
  rankIntentLabels,
  reuseKnownIntentLabel,
} from "../session-intent-vocabulary.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

describe("rankIntentLabels", () => {
  const entry = (label: string, updatedAt = "2026-01-01T00:00:00Z") => ({
    label,
    updatedAt,
  });

  it("counts repeated labels and puts the most reused first", () => {
    expect(
      rankIntentLabels([
        entry("需求澄清"),
        entry("缺陷修复", "2026-01-02T00:00:00Z"),
        entry("缺陷修复", "2026-01-03T00:00:00Z"),
      ]),
    ).toEqual(["缺陷修复", "需求澄清"]);
  });

  it("breaks a usage tie by the most recent session", () => {
    expect(
      rankIntentLabels([
        entry("需求澄清", "2026-01-01T00:00:00Z"),
        entry("缺陷修复", "2026-02-01T00:00:00Z"),
      ]),
    ).toEqual(["缺陷修复", "需求澄清"]);
  });

  it("drops labels that could not be persisted and collapses spellings", () => {
    expect(
      rankIntentLabels([
        entry("修"),
        entry("未分类"),
        entry("缺陷修复"),
        entry(" 缺陷修复 "),
      ]),
    ).toEqual(["缺陷修复"]);
  });

  it("caps the vocabulary handed to one prompt", () => {
    const entries = ["缺陷修复", "需求澄清", "代码实现"].map((label) =>
      entry(label),
    );
    expect(rankIntentLabels(entries, 2)).toHaveLength(2);
  });
});

describe("reuseKnownIntentLabel", () => {
  const known = ["Bugfix", "缺陷修复"];

  it("keeps the label the workspace already publishes", () => {
    expect(reuseKnownIntentLabel("缺陷修复", known)).toBe("缺陷修复");
  });

  it("snaps a spelling-only variant onto the existing label", () => {
    expect(reuseKnownIntentLabel("bugfix", known)).toBe("Bugfix");
    expect(reuseKnownIntentLabel("Bugfix。", known)).toBe("Bugfix");
    expect(reuseKnownIntentLabel("Bug fix", known)).toBe("Bugfix");
  });

  it("keeps a genuinely new label", () => {
    expect(reuseKnownIntentLabel("性能优化", known)).toBe("性能优化");
  });

  it("keeps the label when the workspace has no vocabulary yet", () => {
    expect(reuseKnownIntentLabel("缺陷修复", [])).toBe("缺陷修复");
  });
});

describe("listWorkspaceIntentLabels", () => {
  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
  });

  const createSession = (projectId: string, intentCategory: string) =>
    agentSessionRuntime.create({
      projectId,
      profileId: "synax",
      prompt: `request-${intentCategory}`,
      sessionMetadata: { source: "session-page", intentCategory },
    });

  it("reads the labels already published in this workspace", () => {
    createSession("project-alpha", "缺陷修复");
    createSession("project-alpha", "缺陷修复");
    createSession("project-alpha", "需求澄清");
    createSession("project-beta", "性能优化");

    expect(listWorkspaceIntentLabels("project-alpha")).toEqual([
      "缺陷修复",
      "需求澄清",
    ]);
  });

  it("has no vocabulary for an unknown or empty workspace", () => {
    createSession("project-alpha", "缺陷修复");

    expect(listWorkspaceIntentLabels("project-beta")).toEqual([]);
    expect(listWorkspaceIntentLabels("")).toEqual([]);
  });
});
