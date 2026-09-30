import { randomUUID } from "node:crypto";
import type { GitEpic, GitBranchLinks, GitLinkedSession } from "./git-epic-contracts.js";
import type { GitWorktreeSummary } from "./git-workspaces.js";
import { GitMrStore } from "./git-mr/store.js";
import { GitWorkspaceError } from "./git-workspaces.js";

export class GitEpicStore {
  constructor(private store = new GitMrStore()) {}
  async list(projectId: string, rootId: string): Promise<GitEpic[]> {
    return (await this.store.list<GitEpic>("epics", projectId)).filter(epic => epic.rootId === rootId);
  }
  async save(projectId: string, rootId: string, input: Omit<GitEpic, "projectId" | "rootId" | "id" | "version"> & { id?: string; expectedVersion?: number }): Promise<GitEpic> {
    return this.store.exclusive(`epics:${projectId}:${rootId}`, async () => {
      const existing = input.id ? (await this.list(projectId, rootId)).find(item => item.id === input.id) : undefined;
      if (input.id && !existing) throw new GitWorkspaceError("Epic not found.", 404);
      if (existing && existing.version !== input.expectedVersion) throw new GitWorkspaceError("Epic changed. Refresh before saving.", 409);
      const epic: GitEpic = { id: existing?.id ?? randomUUID(), projectId, rootId, name: input.name.trim(), description: input.description, refs: [...new Set(input.refs)], sessionIds: [...new Set(input.sessionIds)], archived: input.archived, version: (existing?.version ?? 0) + 1 };
      await this.store.write("epics", epic);
      return epic;
    });
  }
}
export interface BranchSession extends GitLinkedSession { workPaths: string[] }
/** Only active sessions are passed by the caller; explicit Epic links are filtered likewise. */
export function indexBranchSessions(refs: string[], worktrees: Pick<GitWorktreeSummary, "path" | "branch">[], sessions: BranchSession[], epics: GitEpic[]): GitBranchLinks[] {
  const activeEpics = epics.filter(epic => !epic.archived);
  const allRefs = new Set([...refs, ...activeEpics.flatMap(epic => epic.refs)]);
  return [...allRefs].map(ref => {
    const linkedEpics = activeEpics.filter(epic => epic.refs.includes(ref));
    const paths = new Set(worktrees.filter(tree => tree.branch && `refs/heads/${tree.branch}` === ref).map(tree => tree.path));
    const linked = sessions.filter(session => session.workPaths.some(workPath => paths.has(workPath)) || linkedEpics.some(epic => epic.sessionIds.includes(session.id)));
    return { ref, sessions: linked.map(({ id, title, status }) => ({ id, title, status })), epicIds: linkedEpics.map(epic => epic.id) };
  });
}
export const gitEpicStore = new GitEpicStore();
