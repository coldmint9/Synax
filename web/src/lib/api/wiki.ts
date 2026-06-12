// ---------------------------------------------------------------------------
// web/src/lib/api/wiki.ts — Wiki HTTP 客户端
// ---------------------------------------------------------------------------

import type {
  WikiSnapshotTree,
  WikiRefreshDraft,
} from '../contracts/wiki';
import { apiRequest } from './origin';

const BASE = '/api/wiki';

export const wikiApi = {
  getProjectSnapshot(projectId: string): Promise<WikiSnapshotTree> {
    return apiRequest<WikiSnapshotTree>(`${BASE}/projects/${projectId}/snapshot`);
  },

  getSnapshot(snapshotId: string): Promise<WikiSnapshotTree> {
    return apiRequest<WikiSnapshotTree>(`${BASE}/snapshots/${snapshotId}`);
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

  approveSnapshot(
    snapshotId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string; message: string }> {
    return apiRequest<{ status: string; message: string }>(`${BASE}/snapshots/${snapshotId}/approve`, {
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

  applyDraft(draftId: string): Promise<{ applied: string[]; conflicts: Array<{ documentId: string; manualState: string }> }> {
    return apiRequest(`${BASE}/drafts/${draftId}/apply`, { method: 'POST', body: JSON.stringify({}) });
  },

  applyPartialDraft(draftId: string, documentIds: string[]): Promise<{ applied: string[]; conflicts: Array<{ documentId: string; manualState: string }> }> {
    return apiRequest(`${BASE}/drafts/${draftId}/apply-partial`, {
      method: 'POST',
      body: JSON.stringify({ documentIds }),
    });
  },

  editDraft(draftId: string, changes: Array<{ documentId: string; newContentMd: string }>): Promise<{ applied: string[]; conflicts: Array<{ documentId: string; manualState: string }> }> {
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
    documentId: string;
    documentTitle: string;
    snippet: string;
    rank: number;
  }>;
  total: number;
}
