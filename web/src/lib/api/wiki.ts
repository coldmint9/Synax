// ---------------------------------------------------------------------------
// web/src/lib/api/wiki.ts — Wiki HTTP 客户端
// ---------------------------------------------------------------------------

import type {
  WikiSnapshotTree,
  WikiRefreshDraft,
  WikiWriteQueueState,
} from '../contracts/wiki';
import { apiFetch, apiRequest } from './origin';
import { createAppError, handleError, AppError } from '../errors';

const BASE = '/api/wiki';

export class WikiGenerationConflictError extends AppError {
  snapshotId?: string;
  generationStatus?: string;

  constructor(message: string, snapshotId?: string, generationStatus?: string) {
    super(message, { level: 'business', code: 'GENERATION_IN_PROGRESS', statusCode: 409 });
    this.snapshotId = snapshotId;
    this.generationStatus = generationStatus;
  }
}

async function postWikiAction<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await apiFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let payload: { error?: string; code?: string; snapshotId?: string; status?: string } = {};
  try {
    payload = await resp.json() as typeof payload;
  } catch {
    // ignore parse errors
  }

  if (resp.status === 409 && payload.code === 'GENERATION_IN_PROGRESS') {
    throw new WikiGenerationConflictError(
      payload.error ?? 'Wiki generation is already in progress.',
      payload.snapshotId,
      payload.status,
    );
  }

  if (!resp.ok) {
    const appErr = createAppError(payload.error ?? `请求失败 (${resp.status})`, resp.status, payload.code);
    handleError(appErr);
    throw appErr;
  }

  return payload as T;
}

export const wikiApi = {
  getProjectSnapshot(projectId: string): Promise<WikiSnapshotTree> {
    return apiRequest<WikiSnapshotTree>(`${BASE}/projects/${projectId}/snapshot`);
  },

  getSnapshot(snapshotId: string): Promise<WikiSnapshotTree> {
    return apiRequest<WikiSnapshotTree>(`${BASE}/snapshots/${snapshotId}`);
  },

  getWriteQueue(snapshotId: string): Promise<WikiWriteQueueState> {
    return apiRequest<WikiWriteQueueState>(`${BASE}/snapshots/${snapshotId}/write-queue`);
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
    return postWikiAction<{ status: string }>(`/projects/${projectId}/generate`, body);
  },

  reinitialize(
    projectId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string }> {
    return postWikiAction<{ status: string }>(`/projects/${projectId}/reinitialize`, body);
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
