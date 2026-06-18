import { agentRuntimeStore } from '../../agent-runtime/session-store.js';
import { wikiStore } from '../wiki-store.js';
import type { WikiSnapshot } from '../contracts.js';

export interface WikiAgentScope {
  projectId: string;
  snapshot: WikiSnapshot | null;
}

export async function resolveWikiAgentScope(
  sessionId: string,
  snapshotId?: string,
): Promise<WikiAgentScope | { error: string }> {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session?.projectId) {
    return { error: 'Session has no projectId — cannot resolve wiki scope.' };
  }

  const snapshot = snapshotId
    ? await wikiStore.getSnapshot(snapshotId)
    : await wikiStore.getLatestSnapshot(session.projectId);

  if (snapshotId && !snapshot) {
    return { error: `Snapshot "${snapshotId}" not found.` };
  }
  if (snapshot && snapshot.projectId !== session.projectId) {
    return { error: 'Snapshot does not belong to the current project.' };
  }

  return { projectId: session.projectId, snapshot };
}

export function buildDocumentTitleMap(
  documents: Array<{ id: string; title: string }>,
): Map<string, string> {
  return new Map(documents.map((doc) => [doc.id, doc.title]));
}

export interface WikiTreeNode {
  id: string;
  title: string;
  docType: string;
  parentId: string | null;
  hasContent: boolean;
  sortOrder: number;
  children: WikiTreeNode[];
}

export function buildWikiDocumentTree(
  documents: Array<{
    id: string;
    title: string;
    docType: string;
    parentId: string | null;
    contentMd: string;
    sortOrder: number;
  }>,
): WikiTreeNode[] {
  const nodes = new Map<string, WikiTreeNode>();
  for (const doc of documents) {
    nodes.set(doc.id, {
      id: doc.id,
      title: doc.title,
      docType: doc.docType,
      parentId: doc.parentId,
      hasContent: doc.contentMd.trim().length > 0,
      sortOrder: doc.sortOrder,
      children: [],
    });
  }

  const roots: WikiTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (items: WikiTreeNode[]) => {
    items.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}
