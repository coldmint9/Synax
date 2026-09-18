import { describe, expect, it, beforeAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { skillRegistry } from "../skill-registry.js";
import { skillAgentBridge } from "../agent-bridge.js";
import { agentSessionRuntime } from "../../agent-runtime/session-runtime.js";
import {
  resetAgentRuntimeFixtures,
  explorerSessionInput,
} from "../../agent-runtime/__tests__/agent-runtime-fixtures.js";

describe("skillRegistry", () => {
  it("lists builtin skills for explorer profile", () => {
    const skills = skillRegistry.listSummaries({
      profileId: "explorer",
      projectId: "project-alpha",
    });
    expect(
      skills.some((skill) => skill.id === "synax-builtin/synax-explore"),
    ).toBe(true);
    expect(
      skills.some((skill) => skill.id === "synax-builtin/code-review"),
    ).toBe(false);
  });

  it("loads skill content through the agent bridge", () => {
    resetAgentRuntimeFixtures();
    const session = agentSessionRuntime.create(explorerSessionInput);
    const skill = skillAgentBridge.loadForTool({
      sessionId: session.id,
      skillId: "synax-builtin/synax-explore",
      profileKind: "explorer",
    });

    expect(skill.content).toContain("Investigate architecture");
  });

  it("only advertises readable local skill files in an available state", () => {
    const installPath = fileURLToPath(
      new URL("./fixtures/sample-skill/SKILL.md", import.meta.url),
    );
    const spy = vi
      .spyOn(skillRegistry, "listSummaries")
      .mockReturnValue([
        summary({ id: "loaded", installPath }),
        summary({ id: "update", installPath, status: "update_available" }),
        summary({ id: "catalog-only" }),
        summary({ id: "missing", installPath: installPath + ".missing" }),
        summary({
          id: "directory",
          installPath: fileURLToPath(new URL("./fixtures/", import.meta.url)),
        }),
        summary({ id: "disabled", installPath, status: "disabled" }),
        summary({
          id: "deterministic",
          installPath,
          injection: "deterministic",
        }),
      ]);
    try {
      expect(
        skillAgentBridge
          .listForPrompt({
            profileId: "explorer",
            projectId: "project-alpha",
            activeSkillIds: [],
          })
          .map((s) => s.id),
      ).toEqual(["loaded", "update"]);
      expect(spy).toHaveBeenCalledWith({
        profileId: "explorer",
        projectId: "project-alpha",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

import { matchesProfile } from "../skill-registry.js";
import { ensureWikiProfileRegistered } from "../../wiki/wiki-loop-profile.js";
import type { SkillSummary } from "../types.js";

function summary(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: "builtin/test-skill",
    name: "test-skill",
    label: "Test Skill",
    description: "test",
    sourceId: "builtin",
    sourceKind: "builtin",
    version: "1.0.0",
    appliesTo: [],
    requiredCapabilities: [],
    permissionHints: [],
    status: "available",
    ...overrides,
  };
}

describe("matchesProfile — profileIds precedence", () => {
  beforeAll(() => {
    ensureWikiProfileRegistered();
  });

  it("matches only the listed profile id", () => {
    const skill = summary({
      appliesTo: ["executor"],
      profileIds: ["wiki-document-writer"],
    });
    expect(matchesProfile(skill, "wiki-document-writer")).toBe(true);
  });

  it("excludes other executors when profileIds is set", () => {
    const skill = summary({
      appliesTo: ["executor"],
      profileIds: ["wiki-document-writer"],
    });
    expect(matchesProfile(skill, "wiki-writer")).toBe(false);
  });

  it("falls back to appliesTo when profileIds is empty", () => {
    const skill = summary({ appliesTo: ["executor"], profileIds: [] });
    expect(matchesProfile(skill, "wiki-writer")).toBe(true);
  });

  it("falls back to appliesTo when profileIds is absent", () => {
    const skill = summary({ appliesTo: ["executor"] });
    expect(matchesProfile(skill, "wiki-writer")).toBe(true);
  });

  it("still matches everything when appliesTo and profileIds are both empty", () => {
    expect(matchesProfile(summary({}), "wiki-planner")).toBe(true);
  });
});
