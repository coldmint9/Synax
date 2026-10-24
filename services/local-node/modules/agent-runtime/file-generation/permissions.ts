import type { RegisteredTool } from "../contracts.js";
import { agentRuntimeStore } from "../session-store.js";
import { profileService } from "../profile-service.js";
import { extensionStore } from "../../extensions/extension-store.js";
import { isToolMountedForSession, profileCanUseTool } from "../tool-mount-policy.js";
import { resolvePermissionDecision } from "../permission-policy.js";
import { assertSpecialistToolAllowed } from "../specialist-profile.js";
import { assertSubagentToolAllowed } from "../subagent-profile.js";
import { fileDeleteTool } from "../tools/file-delete.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../tools/workspace.js";

const generate: RegisteredTool = { ...fileDeleteTool, id: "file.generate", internalGate: "write" };

/** Script approval does not grant a disabled capability or override path denies. */
export function assertGenerationAllowed(sessionId: string, paths: string[], deletePaths: string[]): void {
  const session = agentRuntimeStore.getSession(sessionId);
  const profile = profileService.getForSession(session);
  for (const [tool, candidates] of [[generate, paths], [fileDeleteTool, deletePaths]] as const) {
    if (!candidates.length) continue;
    if (!isToolMountedForSession(session, tool) || !profileCanUseTool(profile, tool) || !extensionStore.active(session.projectId, "tool", tool.id))
      throw new Error(`${tool.id} capability is unavailable to this session.`);
    for (const candidate of candidates) {
      const args = { path: candidate };
      assertSpecialistToolAllowed(session, tool.id, args);
      assertSubagentToolAllowed(session, tool, args);
      const canonical = toWorkspaceRelative(resolveWorkspacePath(candidate, sessionId), sessionId);
      for (const pattern of [tool.id, candidate, canonical]) {
        const decision = resolvePermissionDecision({ sessionId, category: tool.category, internalGate: tool.internalGate,
          pattern, rules: session.permissionRules, isSubSession: Boolean(session.parentSessionId) });
        if (decision.action === "deny") throw new Error(`Permissions deny ${tool.id} for ${candidate}.`);
      }
    }
  }
}
