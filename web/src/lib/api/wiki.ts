// ---------------------------------------------------------------------------
// web/src/lib/api/wiki.ts — Wiki HTTP 客户端
// ---------------------------------------------------------------------------

import type {
  WikiSnapshotTree,
  WikiBlock,
  WikiPatch,
} from '../contracts/wiki';
import { apiRequest } from './origin';

const BASE = '/api/wiki';

export const wikiApi = {
  getLatest(projectId: string): Promise<WikiSnapshotTree> {
    return apiRequest<WikiSnapshotTree>(`${BASE}/projects/${projectId}/latest`);
  },

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
};
