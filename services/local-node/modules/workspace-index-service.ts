import {
  workspaceRootHostPath,
  projectWorkspaceRoots,
  listWorkspaceProjects,
  type ProjectWorkspaceRoot,
} from './project-workspace.js';
import { runtimeFacade } from './agent-runtime/sidecar/runtime-facade.js';
import { logger } from '../infrastructure/runtime/logger.js';

export interface IndexedTreeEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  hasChildren: boolean;
  ignored: boolean;
}
export interface IndexedTreeListing {
  projectId: string;
  rootId: string;
  rootName: string;
  rootPath: string;
  path: string;
  entries: IndexedTreeEntry[];
  truncated: boolean;
  nextCursor: string | null;
  revision: number;
  indexing: boolean;
}
type DirectoryPage = Omit<IndexedTreeListing, 'projectId' | 'rootId' | 'rootName' | 'rootPath'>;

/** HTTP/lifecycle adapter only. All scanning, ignore rules, watching and caching
 * live in Rust. A missing sidecar is an error, never a Node traversal fallback. */
export class WorkspaceIndexService {
  private scheduled = false;
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;

  start(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      for (const project of listWorkspaceProjects()) {
        this.indexProject(project.id, projectWorkspaceRoots(project));
      }
    });
  }

  indexProject(_projectId: string, roots: ProjectWorkspaceRoot[]): void {
    for (const root of roots) {
      if (root.status !== 'available') continue;
      const hostPath = workspaceRootHostPath(root);
      if (this.pending.has(hostPath)) continue;
      this.pending.add(hostPath);
      this.queue.push(hostPath);
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < 2 && this.queue.length) {
      const hostPath = this.queue.shift()!;
      this.active++;
      void runtimeFacade.workspaceIndexCommand('register', { hostPath })
        .catch(error => logger.warn({ err: String(error) }, '[workspace-index] Rust registration failed'))
        .finally(() => {
          this.active--;
          this.pending.delete(hostPath);
          this.pump();
        });
    }
  }

  async listChildren(input: {
    projectId: string;
    root: ProjectWorkspaceRoot;
    relativePath?: string;
    showHidden?: boolean;
    showIgnored?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<IndexedTreeListing> {
    const request = {
      hostPath: workspaceRootHostPath(input.root),
      path: input.relativePath ?? '',
      showHidden: input.showHidden === true,
      showIgnored: input.showIgnored === true,
      cursor: input.cursor,
      limit: input.limit ?? 100,
    };
    // A mutation racing the initial directory read can be retried immediately;
    // an expired continuation must reach the client so it restarts that page.
    let page: DirectoryPage;
    try { page = await runtimeFacade.workspaceIndexCommand<DirectoryPage>('list', request); }
    catch (error) {
      if (input.cursor || (error as { code?: string }).code !== 'INDEX_CURSOR_STALE') throw error;
      page = await runtimeFacade.workspaceIndexCommand<DirectoryPage>('list', request);
    }
    return {
      ...page,
      projectId: input.projectId,
      rootId: input.root.id,
      rootName: input.root.name,
      rootPath: input.root.path,
    };
  }

  status(root: ProjectWorkspaceRoot): Promise<{ revision: number; indexing: boolean }> {
    return runtimeFacade.workspaceIndexCommand('status', { hostPath: workspaceRootHostPath(root) });
  }
}
export const workspaceIndexService = new WorkspaceIndexService();
