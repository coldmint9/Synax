import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  QUICK_ACTIONS,
  QUICK_ACTION_CATEGORIES,
  appendQuickActionContext,
  buildQuickActionLaunch,
  findQuickAction,
  quickActionAttachment,
  quickActionSkills,
  restrictQuickActionSkills,
  visibleQuickActions,
  type QuickAction,
} from "./quickActions";

const builtinSkillsRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "services", "local-node", "skills", "builtin",
);

const launches = QUICK_ACTIONS.filter((action) => action.kind === "launch");

describe("quick action catalog", () => {
  it("keeps ids unique and every action in a known category", () => {
    const ids = QUICK_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(QUICK_ACTION_CATEGORIES.map((item) => item.id));
    for (const action of QUICK_ACTIONS) {
      expect(categories.has(action.category)).toBe(true);
      expect(action.title.zh.length).toBeGreaterThan(0);
      expect(action.title.en.length).toBeGreaterThan(0);
    }
  });

  it("mounts skill files that actually exist", () => {
    for (const action of launches) {
      const skills = quickActionSkills(action, true);
      expect(skills.length).toBeGreaterThan(0);
      for (const skill of skills) {
        const name = skill.id.replace(/^synax-builtin\//, "");
        const file = path.join(builtinSkillsRoot, name, "SKILL.md");
        expect(fs.existsSync(file), `${action.id} -> ${skill.id}`).toBe(true);
        expect(fs.readFileSync(file, "utf8")).toContain(`name: ${name}`);
      }
    }
  });

  it("describes composite procedures, not single prompts", () => {
    const byId = new Map(QUICK_ACTIONS.map((action) => [action.id, action]));
    const gate = byId.get("release-gate")!;
    expect(gate.kind).toBe("launch");
    if (gate.kind !== "launch") return;
    expect(gate.mode).toBe("goal");
    expect(gate.skills.map((item) => item.id)).toEqual([
      "synax-builtin/release-readiness",
      "synax-builtin/code-review",
      "synax-builtin/test-augmentation",
      "synax-builtin/verification-before-completion",
    ]);

    const onboarding = byId.get("project-onboarding")!;
    expect(onboarding.kind).toBe("launch");
    if (onboarding.kind !== "launch") return;
    expect(onboarding.skills.map((item) => item.id)).toContain("synax-builtin/visualize");
    expect(QUICK_ACTIONS.filter((action) => action.featured).map((action) => action.id))
      .toEqual(["project-onboarding", "release-gate"]);
  });

  it("separates procedures that need user context from instant ones", () => {
    const compose = QUICK_ACTIONS.filter(
      (action) => action.kind === "launch" && action.policy === "compose",
    ).map((action) => action.id);
    expect(compose).toEqual(["requirement-breakdown", "visual-explainer", "diagnose"]);

    // Every action that waits for user context must say what it needs.
    for (const action of QUICK_ACTIONS) {
      if (action.kind !== "launch" || action.policy !== "compose") continue;
      expect(action.input, action.id).toBeDefined();
      expect(action.input!.hint.zh.length).toBeGreaterThan(0);
      expect(action.input!.placeholder.en.length).toBeGreaterThan(0);
    }

    const diagnose = QUICK_ACTIONS.find((action) => action.id === "diagnose")!;
    const diagnoseLaunch = buildQuickActionLaunch(diagnose, { locale: "en", signedIn: true })!;
    expect(quickActionAttachment(diagnose, diagnoseLaunch, "en")).toMatchObject({
      actionId: "diagnose",
      requiresInput: true,
      hint: "observed behavior, reproduction steps and expectations",
      placeholder: "Describe the symptom, then the steps to reproduce and expected behavior…",
      skillIds: ["synax-builtin/systematic-debugging", "synax-builtin/synax-explore"],
    });

    const review = QUICK_ACTIONS.find((action) => action.id === "code-review")!;
    const reviewLaunch = buildQuickActionLaunch(review, { locale: "zh" })!;
    expect(quickActionAttachment(review, reviewLaunch, "zh")).toMatchObject({
      actionId: "code-review",
      requiresInput: false,
    });
  });

  it("drops unavailable skills from both the mount list and the kickoff text", () => {
    const plan = QUICK_ACTIONS.find((action) => action.id === "project-onboarding")!;
    const launch = buildQuickActionLaunch(plan, { locale: "en", signedIn: true })!;
    expect(launch.text).toContain("Interactive diagram");

    const restricted = restrictQuickActionSkills(plan, launch, "en", ["synax-builtin/project-onboarding"]);
    expect(restricted.skillIds).toEqual(["synax-builtin/project-onboarding"]);
    expect(restricted.text).not.toContain("Interactive diagram");
    expect(restrictQuickActionSkills(plan, launch, "en", undefined)).toBe(launch);
  });

  it("builds a localized, deduplicated kickoff for every launch action", () => {
    for (const action of launches) {
      for (const locale of ["zh", "en"] as const) {
        const launch = buildQuickActionLaunch(action, { locale, signedIn: true })!;
        expect(launch.text.length).toBeGreaterThan(80);
        expect(new Set(launch.skillIds).size).toBe(launch.skillIds.length);
        expect(["chat", "goal"]).toContain(launch.mode);
      }
    }
  });

  it("filters by category", () => {
    expect(visibleQuickActions(QUICK_ACTIONS, { category: "quality", signedIn: true }).map((action) => action.id))
      .toEqual(["code-review", "diagnose", "test-gap"]);
  });

  it("keeps typed text as additional context instead of discarding it", () => {
    const action: QuickAction = QUICK_ACTIONS[0]!;
    const launch = buildQuickActionLaunch(action, { locale: "en" })!;
    expect(launch.text).toContain("Skills attached to this session");
    const withContext = appendQuickActionContext(launch.text, "Focus on auth", "en");
    expect(withContext).toContain("## Additional context\n\nFocus on auth");
    expect(appendQuickActionContext(launch.text, "   ", "en")).toBe(launch.text);
  });

  it("routes any typed question through the visualize skill", () => {
    const action = findQuickAction("visual-explainer")!;
    expect(action.kind).toBe("launch");
    if (action.kind !== "launch") return;
    expect(action.policy).toBe("compose");
    expect(action.skills.map((item) => item.id)).toEqual(["synax-builtin/visualize"]);

    const launch = buildQuickActionLaunch(action, { locale: "zh", signedIn: true })!;
    expect(launch.skillIds).toEqual(["synax-builtin/visualize"]);
    expect(launch.text).toContain("交互式图解");
    expect(launch.text).toContain("交互图解");
    expect(buildQuickActionLaunch(action, { locale: "en" })!.text).toContain("interactive visualization");

    const attachment = quickActionAttachment(action, launch, "zh")!;
    expect(attachment).toMatchObject({
      actionId: "visual-explainer",
      requiresInput: true,
      skillIds: ["synax-builtin/visualize"],
    });
    // The typed question becomes the subject of the diagram, never a replacement.
    const message = appendQuickActionContext(attachment.text, "鉴权是怎么走的？", "zh");
    expect(message).toContain("待图解的问题：");
    expect(message.endsWith("## 补充上下文\n\n鉴权是怎么走的？")).toBe(true);
  });
});
