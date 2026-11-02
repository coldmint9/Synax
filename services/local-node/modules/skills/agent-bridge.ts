import { listGitSkills, loadGitSkill } from '../agent-runtime/git/skills.js';
import { assertGitMrBinding } from '../agent-runtime/git/binding.js';
import fs from "node:fs";
import type { AgentProfileKind, AgentSession } from "../agent-runtime/contracts.js";
import { permissionPolicy, resolvePermissionDecision } from "../agent-runtime/permission-policy.js";
import { AgentPermissionError } from "../agent-runtime/runtime-errors.js";
// Skill lookup only needs stored session data. Importing the session runtime
// here cycles through presentation tools and the worker's tool registry.
import { agentRuntimeStore } from "../agent-runtime/session-store.js";
import { profileService } from "../agent-runtime/profile-service.js";
import { matchesProfile, skillRegistry } from "./skill-registry.js";
import type { SkillDetail, SkillSummary } from "./types.js";

function loadApplicableSkill(session: AgentSession, skillId: string): SkillDetail {
  if (session.profileId === 'git-manager') {
    assertGitMrBinding(session.id);
    return loadGitSkill(skillId);
  }
  const summary = skillRegistry.getSummary(skillId, session.projectId);
  if (!matchesProfile(summary, session.profileId)) {
    throw new AgentPermissionError(`Skill ${summary.id} does not apply to ${session.profileId}.`);
  }
  return skillRegistry.loadDetail({ skillId, projectId: session.projectId });
}

export const skillAgentBridge = {
  canRetainForContext(sessionId: string, skillId: string, expectedContent?: string): boolean {
    try {
      const session = agentRuntimeStore.getSession(sessionId);
      const profile = profileService.getForSession(session);
      if (!profile.allowedCapabilities.includes("skill.load")) return false;
      // Retention is a read-only eligibility query, not another tool execution
      // or approval. In particular, a past "once" grant cannot satisfy a new ask.
      const decision = resolvePermissionDecision({ sessionId, category: "skill", internalGate: "skill",
        pattern: skillId, rules: session.permissionRules, isSubSession: Boolean(session.parentSessionId),
        metadata: { toolId: "skill.load", args: { skillId } } });
      if (decision.action !== "allow") return false;
      const skill = loadApplicableSkill(session, skillId);
      return expectedContent === undefined || skill.content === expectedContent;
    } catch { return false; }
  },
  listForPrompt(input: {
    profileId: string;
    projectId: string;
    activeSkillIds: string[];
    /**
     * Account scopes the user is currently signed in to. Skills declaring
     * `requires-account` stay hidden until their scope is present, so a prompt
     * never advertises guidance for capabilities the session no longer has.
     */
    signedInAccounts?: readonly string[];
  }): SkillSummary[] {
    if (input.profileId === 'git-manager') return listGitSkills();
    const selected = new Set(input.activeSkillIds);
    const accounts = new Set(input.signedInAccounts ?? []);
    return skillRegistry
      .listSummaries({
        profileId: input.profileId,
        projectId: input.projectId,
      })
      .filter((skill) => {
        if (
          skill.injection === "deterministic" ||
          !skill.installPath ||
          !["available", "update_available"].includes(skill.status) ||
          (skill.requiresAccounts ?? []).some((account) => !accounts.has(account))
        )
          return false;
        try {
          fs.accessSync(skill.installPath, fs.constants.R_OK);
          return fs.statSync(skill.installPath).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.id.localeCompare(b.id));
  },

  loadForTool(input: {
    sessionId: string;
    skillId: string;
    profileKind: AgentProfileKind;
  }): SkillDetail {
    const session = agentRuntimeStore.getSession(input.sessionId);
    const skill = loadApplicableSkill(session, input.skillId);
    if (session.profileId === 'git-manager') return skill;

    const decision = permissionPolicy.evaluate({
      sessionId: input.sessionId,
      category: "skill",
      internalGate: "skill",
      pattern: input.skillId,
    });
    if (decision.action === "deny")
      throw new AgentPermissionError(decision.reason);
    if (decision.action === "ask")
      throw new AgentPermissionError("Skill content requires permission.", 409);

    return skill;
  },
};

export function getSkillRegistry() {
  return skillRegistry;
}
