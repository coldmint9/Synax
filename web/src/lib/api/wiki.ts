// ---------------------------------------------------------------------------
// web/src/lib/api/wiki.ts — Wiki HTTP 客户端
// ---------------------------------------------------------------------------

import type {
  WikiSnapshotTree,
  WikiBlock,
  WikiPatch,
  WikiRefreshDraft,
} from '../contracts/wiki';
import { apiRequest } from './origin';

const BASE = '/api/wiki';

export const wikiApi = {
  getSnapshot(snapshotId: string): Promise<WikiSnapshotTree> {
    return apiRequest<WikiSnapshotTree>(`${BASE}/snapshots/${snapshotId}`);
  },

  updateBlock(
    blockId: string,
    body: { content: unknown; manualState?: 'edited' | 'locked'; actorId?: string },
  ): Promise<WikiBlock> {
    return apiRequest<WikiBlock>(`${BASE}/blocks/${blockId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  async getPatches(projectId: string, status?: string): Promise<WikiPatch[]> {
    const url = status
      ? `${BASE}/projects/${projectId}/patches?status=${status}`
      : `${BASE}/projects/${projectId}/patches`;
    const data = await apiRequest<{ patches: WikiPatch[] }>(url);
    return data.patches;
  },

  exportSnapshotUrl(snapshotId: string, refs = false): string {
    return `${BASE}/snapshots/${snapshotId}/export.md${refs ? '?refs=1' : ''}`;
  },

  exportDocumentUrl(documentId: string, refs = false): string {
    return `${BASE}/documents/${documentId}/export.md${refs ? '?refs=1' : ''}`;
  },

  generate(
    projectId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`${BASE}/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  reinitialize(
    projectId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`${BASE}/projects/${projectId}/reinitialize`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  continueGeneration(
    snapshotId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`${BASE}/snapshots/${snapshotId}/continue`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  resolveBinding(bindingId: string): Promise<{
    resolved: boolean;
    precision: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    qualifiedName?: string;
    ideUri?: string;
    fallbackSearchQuery?: string;
  }> {
    return apiRequest(`${BASE}/source-bindings/${bindingId}/resolve`);
  },

  // ── Draft API ───────────────────────────────────────────────────────────────

  async getDrafts(projectId: string, status?: string): Promise<WikiRefreshDraft[]> {
    const url = status
      ? `${BASE}/projects/${projectId}/drafts?status=${status}`
      : `${BASE}/projects/${projectId}/drafts`;
    const data = await apiRequest<{ drafts: WikiRefreshDraft[] }>(url);
    return data.drafts;
  },

  getDraft(draftId: string): Promise<WikiRefreshDraft> {
    return apiRequest<WikiRefreshDraft>(`${BASE}/drafts/${draftId}`);
  },

  applyDraft(draftId: string): Promise<{ applied: string[]; conflicts: Array<{ blockId: string; manualState: string }> }> {
    return apiRequest(`${BASE}/drafts/${draftId}/apply`, { method: 'POST', body: JSON.stringify({}) });
  },

  applyPartialDraft(draftId: string, blockIds: string[]): Promise<{ applied: string[]; conflicts: Array<{ blockId: string; manualState: string }> }> {
    return apiRequest(`${BASE}/drafts/${draftId}/apply-partial`, {
      method: 'POST',
      body: JSON.stringify({ blockIds }),
    });
  },

  editDraft(draftId: string, changes: Array<{ blockId: string; newContent: unknown }>): Promise<{ applied: string[]; conflicts: Array<{ blockId: string; manualState: string }> }> {
    return apiRequest(`${BASE}/drafts/${draftId}/edit`, {
      method: 'POST',
      body: JSON.stringify({ changes }),
    });
  },

  discardDraft(draftId: string): Promise<{ ok: true }> {
    return apiRequest(`${BASE}/drafts/${draftId}/discard`, { method: 'POST', body: JSON.stringify({}) });
  },

  // ── Search API ──────────────────────────────────────────────────────────────

  async search(projectId: string, query: string, opts?: { limit?: number; documentId?: string }): Promise<WikiSearchApiResult> {
    const params = new URLSearchParams({ q: query });
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.documentId) params.set('documentId', opts.documentId);
    return apiRequest<WikiSearchApiResult>(`${BASE}/projects/${projectId}/search?${params}`);
  },
};

export interface WikiSearchApiResult {
  results: Array<{
    blockId: string;
    documentId: string;
    documentTitle: string;
    blockType: string;
    snippet: string;
    rank: number;
  }>;
  total: number;
}
