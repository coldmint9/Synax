import { agentRuntimeStore } from './agent-runtime/session-store.js';
import { normalizeAgentSessionStatus } from './agent-runtime/session-projection.js';
/** Callers hydrate the authoritative session projection at their request boundary. */
export function listGitSessions(projectId?:string) {
  return agentRuntimeStore.listSessions({limit:Number.MAX_SAFE_INTEGER}).filter(s=>!s.sessionMetadata?.archivedAt && !s.sessionMetadata?.deletedAt && (!projectId || s.projectId===projectId)).map(s=>({id:s.id,title:s.title || s.prompt.slice(0,100),status:normalizeAgentSessionStatus(s.status),activeRunId:s.activeRunId,pendingResumeToken:s.pendingResumeToken,runStatus:s.status,backend:s.sessionMetadata?.backend as {workDir?:string;workspaceRoots?:Array<{path:string}>}|undefined}));
}
