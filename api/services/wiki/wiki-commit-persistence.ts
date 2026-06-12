import type { WikiDocType, WikiReference } from './contracts.js';
import { wikiStore } from './wiki-store.js';
import type { WikiClaim, WikiDocumentDraft, WikiOutlineEntry } from './tools/contracts.js';

export interface WikiCommitInput {
  title: string;
  docType: WikiDocType;
  markdown: string;
  references: WikiReference[];
  claims?: WikiClaim[];
  parentPlanId?: string;
  sortOrder?: number;
}

/**
 * Resolve the pre-created empty document id for an outline entry.
 * Outline shells are created in persistOutlineAsEmptyDocs before writing.
 */
export function findExistingDocId(
  doc: Pick<WikiCommitInput, 'title' | 'docType'>,
  outline: WikiOutlineEntry[],
  planIdToDocId: Map<string, string>,
): string | null {
  const match = outline.find(p => p.title === doc.title && p.docType === doc.docType);
  if (!match) return null;
  return planIdToDocId.get(match.id) ?? null;
}

export async function resolveCommittedDocumentId(
  draft: WikiCommitInput,
  snapshotId: string,
  outline: WikiOutlineEntry[] | null,
  planIdToDocId: Map<string, string>,
): Promise<string | null> {
  if (outline) {
    const fromOutline = findExistingDocId(draft, outline, planIdToDocId);
    if (fromOutline) return fromOutline;
  }

  const docs = await wikiStore.getDocumentsBySnapshot(snapshotId);
  const match = docs.find(d => d.title === draft.title && d.docType === draft.docType);
  return match?.id ?? null;
}

export async function fillDocumentContent(
  docId: string,
  draft: Pick<WikiCommitInput, 'markdown' | 'references'>,
): Promise<void> {
  await wikiStore.updateDocumentContent(docId, {
    contentMd: draft.markdown,
    references: draft.references,
  });
}

export async function persistSingleDocument(
  draft: WikiCommitInput,
  snapshotId: string,
  projectId: string,
  parentId?: string | null,
): Promise<string> {
  const doc = await wikiStore.upsertDocument({
    snapshotId,
    projectId,
    title: draft.title,
    docType: draft.docType,
    parentId: parentId ?? null,
    sortOrder: draft.sortOrder,
    contentMd: draft.markdown,
    references: draft.references,
  });
  return doc.id;
}

export function toCommitInput(args: unknown): WikiCommitInput | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  const title = record.title;
  const docType = record.docType;
  const markdown = record.markdown;
  if (typeof title !== 'string' || typeof docType !== 'string' || typeof markdown !== 'string') {
    return null;
  }

  return {
    title,
    docType: docType as WikiDocType,
    markdown,
    references: Array.isArray(record.references) ? record.references as WikiReference[] : [],
    claims: Array.isArray(record.claims) ? record.claims as WikiClaim[] : undefined,
    parentPlanId: typeof record.parentPlanId === 'string' ? record.parentPlanId : undefined,
    sortOrder: typeof record.sortOrder === 'number' ? record.sortOrder : undefined,
  };
}

export async function persistWikiDocumentCommit(input: {
  draft: WikiCommitInput;
  snapshotId: string;
  projectId: string;
  outline: WikiOutlineEntry[] | null;
  planIdToDocId: Map<string, string>;
}): Promise<string> {
  const { draft, snapshotId, projectId, outline, planIdToDocId } = input;

  const existingDocId = await resolveCommittedDocumentId(draft, snapshotId, outline, planIdToDocId);
  if (existingDocId) {
    await fillDocumentContent(existingDocId, draft);
    return existingDocId;
  }

  const resolvedParentId = draft.parentPlanId
    ? planIdToDocId.get(draft.parentPlanId) ?? null
    : null;

  const newId = await persistSingleDocument(draft, snapshotId, projectId, resolvedParentId);
  const planEntry = outline?.find(p => p.title === draft.title && p.docType === draft.docType);
  if (planEntry) planIdToDocId.set(planEntry.id, newId);
  return newId;
}

export function toDocumentDraft(draft: WikiCommitInput): WikiDocumentDraft {
  return {
    title: draft.title,
    docType: draft.docType,
    markdown: draft.markdown,
    references: draft.references,
    claims: draft.claims ?? [],
    parentPlanId: draft.parentPlanId,
    sortOrder: draft.sortOrder,
  };
}
