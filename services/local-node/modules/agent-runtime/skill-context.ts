import { createHash } from "node:crypto";
import { agentRuntimeStore as store } from "./session-store.js";
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { isWorkContinuation } from "./work-intent.js";
import type { SkillDetail } from "../skills/types.js";

interface LoadedSkillContext {
  id: string;
  sessionId: string;
  runId: string | null;
  workId?: string;
  skillId: string;
  digest: string;
  content: string;
  loadedAt: string;
}

/** Successful loads are instruction sources, not disposable historical output.
 * Pin the exact loaded body independently of the compactable transcript. */
export function rememberLoadedSkill(sessionId: string, runId: string | null, skill: SkillDetail): void {
  const record = store.saveRecord<LoadedSkillContext>("context", {
    id: `skill_context_${createHash("sha256").update(JSON.stringify([sessionId, skill.id])).digest("hex")}`,
    sessionId, runId,
    workId: typeof store.getSession(sessionId).sessionMetadata?.activeWorkId === "string"
      ? store.getSession(sessionId).sessionMetadata!.activeWorkId as string : undefined,
    skillId: skill.id, content: skill.content,
    digest: createHash("sha256").update(skill.content).digest("hex"),
    loadedAt: new Date().toISOString(),
  });
  const previous = store.getSession(sessionId).sessionMetadata?.loadedSkillContexts as Record<string, string> | undefined;
  store.updateSessionMetadata(sessionId, { loadedSkillContexts: { ...previous, [skill.id]: record.id } });
}

/** Selected skills are projected from these durable records, not from tool
 * history (which may have been compacted or evicted). Never reuse a body whose
 * current permissions, availability or contents no longer match the load. */
export function hasReusableLoadedSkill(sessionId: string, skillId: string): boolean {
  const loaded = store.listRecords<LoadedSkillContext>("context", sessionId)
    .find(skill => skill.skillId === skillId);
  return Boolean(loaded && typeof loaded.content === "string" &&
    skillAgentBridge.canRetainForContext(sessionId, skillId, loaded.content));
}

export function loadedSkillContext(sessionId: string, selectedIds: readonly string[]): string | null {
  const session = store.getSession(sessionId);
  const selected = new Set(selectedIds);
  const activeRun = session.activeRunId ? store.getRun(session.activeRunId) : undefined;
  const currentInput = activeRun?.triggerMessageId ? store.getMessage(sessionId, activeRun.triggerMessageId) : undefined;
  const continuation = currentInput?.metadata.source === "system_injection" || isWorkContinuation(currentInput?.content ?? "");
  const priorRun = continuation ? store.listRuns(sessionId).filter(run => run.id !== session.activeRunId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id : undefined;
  const currentWork = session.sessionMetadata?.activeWorkId;
  const goal = session.sessionMetadata?.mode === "goal";
  const retained = store.listRecords<LoadedSkillContext>("context", sessionId)
    .filter(skill => typeof skill.skillId === "string" && (skill.runId === session.activeRunId || skill.runId === priorRun ||
      (goal && typeof currentWork === "string" && skill.workId === currentWork) || selected.has(skill.skillId)) &&
      skillAgentBridge.canRetainForContext(sessionId, skill.skillId, skill.content))
    .sort((a, b) => a.skillId.localeCompare(b.skillId));
  if (!retained.length) return null;
  // Reusing a selected body is still active use: subsequent bare continuations
  // must inherit it even though this run did not execute another skill.load.
  if (session.activeRunId) for (const skill of retained) {
    if (skill.runId !== session.activeRunId) store.saveRecord("context", {
      ...skill, runId: session.activeRunId,
      workId: typeof currentWork === "string" ? currentWork : undefined,
    });
  }
  return ["## Loaded skill instructions", "These exact successful loads remain available across context compaction. Do not reload them while present.",
    ...retained.map(skill => `<loaded-skill id=${JSON.stringify(skill.skillId)} sha256=${JSON.stringify(skill.digest)}>\n${skill.content}\n</loaded-skill>`),
  ].join("\n\n");
}
