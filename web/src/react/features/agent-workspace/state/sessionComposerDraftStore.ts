import type { AgentSessionMode, TurnReference } from "../../../../lib/api/agentRuntime";
import { createScopedDraftState } from "../../media/scopedDraftState";
import type { SynaxPermissionTier, SynaxWikiAttachMode } from "../synaxSessionTypes";

export const sessionComposerText = createScopedDraftState<string>();
export const sessionComposerReferences =
  createScopedDraftState<TurnReference[]>();
export const sessionComposerSkills = createScopedDraftState<string[]>();
export const sessionComposerSubmitting = createScopedDraftState<boolean>();
export const sessionComposerEditing = createScopedDraftState<boolean>();
export const sessionComposerChangingMode = createScopedDraftState<boolean>();
export const sessionComposerError = createScopedDraftState<string | null>();
export const sessionComposerMode = createScopedDraftState<AgentSessionMode>();
export const sessionComposerPermissionTier =
  createScopedDraftState<SynaxPermissionTier>();
export const sessionComposerWikiAttachMode =
  createScopedDraftState<SynaxWikiAttachMode>();
export const sessionComposerDocumentId = createScopedDraftState<string | null>();

export function composerDraftScope(projectId: string, sessionId: string) {
  return JSON.stringify([projectId, sessionId]);
}

export function resetSessionComposerDrafts() {
  for (const state of [
    sessionComposerText,
    sessionComposerReferences,
    sessionComposerSkills,
    sessionComposerSubmitting,
    sessionComposerEditing,
    sessionComposerChangingMode,
    sessionComposerError,
    sessionComposerMode,
    sessionComposerPermissionTier,
    sessionComposerWikiAttachMode,
    sessionComposerDocumentId,
  ])
    state.reset();
}
