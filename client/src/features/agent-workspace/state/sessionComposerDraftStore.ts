import type { AgentSessionMode, TurnReference } from "../../../adapters/transport/agentRuntime";
import type { QuickActionAttachment } from "../../quick-actions/quickActions";
import { createScopedDraftState } from "../../media/scopedDraftState";
import type { SynaxPermissionTier } from "../synaxSessionTypes";

export const sessionComposerText = createScopedDraftState<string>();
export const sessionComposerReferences =
  createScopedDraftState<TurnReference[]>();
export const sessionComposerSkills = createScopedDraftState<string[]>();
export const sessionComposerQuickAction =
  createScopedDraftState<QuickActionAttachment | null>();
export const sessionComposerSubmitting = createScopedDraftState<boolean>();
export const sessionComposerEditing = createScopedDraftState<boolean>();
export const sessionComposerChangingMode = createScopedDraftState<boolean>();
export const sessionComposerError = createScopedDraftState<string | null>();
export const sessionComposerMode = createScopedDraftState<AgentSessionMode>();
export const sessionComposerPermissionTier =
  createScopedDraftState<SynaxPermissionTier>();

export function composerDraftScope(projectId: string, sessionId: string) {
  return JSON.stringify([projectId, sessionId]);
}

export function resetSessionComposerDrafts() {
  for (const state of [
    sessionComposerText,
    sessionComposerReferences,
    sessionComposerSkills,
    sessionComposerQuickAction,
    sessionComposerSubmitting,
    sessionComposerEditing,
    sessionComposerChangingMode,
    sessionComposerError,
    sessionComposerMode,
    sessionComposerPermissionTier,
  ])
    state.reset();
}
