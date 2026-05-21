// ---------------------------------------------------------------------------
// web/src/lib/api/wiki.ts — Wiki HTTP 客户端
// ---------------------------------------------------------------------------

import type {
  WikiSnapshotTree,
  WikiBlock,
  WikiPatch,
} from '../contracts/wiki';

const BASE = '/api/wiki';

export const wikiApi = {
  async getLatest(projectId: string): Promise<WikiSnapshotTree> {
    const res = await fetch(`${BASE}/projects/${projectId}/latest`);
    if (!res.ok) throw new Error(`wiki/latest failed: ${res.status}`);
    return res.json() as Promise<WikiSnapshotTree>;
  },

  async getSnapshot(snapshotId: string): Promise<WikiSnapshotTree> {
    const res = await fetch(`${BASE}/snapshots/${snapshotId}`);
    if (!res.ok) throw new Error(`wiki/snapshot failed: ${res.status}`);
    return res.json() as Promise<WikiSnapshotTree>;
  },

  async updateBlock(
    blockId: string,
    body: { content: unknown; manualState?: 'edited' | 'locked'; actorId?: string },
  ): Promise<WikiBlock> {
    const res = await fetch(`${BASE}/blocks/${blockId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`wiki/block update failed: ${res.status}`);
    return res.json() as Promise<WikiBlock>;
  },

  async getPatches(projectId: string, status?: string): Promise<WikiPatch[]> {
    const url = status
      ? `${BASE}/projects/${projectId}/patches?status=${status}`
      : `${BASE}/projects/${projectId}/patches`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wiki/patches failed: ${res.status}`);
    const data = await res.json() as { patches: WikiPatch[] };
    return data.patches;
  },

  exportSnapshotUrl(snapshotId: string, refs = false): string {
    return `${BASE}/snapshots/${snapshotId}/export.md${refs ? '?refs=1' : ''}`;
  },

  exportDocumentUrl(documentId: string, refs = false): string {
    return `${BASE}/documents/${documentId}/export.md${refs ? '?refs=1' : ''}`;
  },

  async generate(
    projectId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string }> {
    const res = await fetch(`${BASE}/projects/${projectId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`wiki/generate failed: ${res.status}`);
    return res.json() as Promise<{ status: string }>;
  },

  async reinitialize(
    projectId: string,
    body: { workDir: string; locale?: 'zh' | 'en' },
  ): Promise<{ status: string }> {
    const res = await fetch(`${BASE}/projects/${projectId}/reinitialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`wiki/reinitialize failed: ${res.status}`);
    return res.json() as Promise<{ status: string }>;
  },

  async resolveBinding(bindingId: string): Promise<{
    resolved: boolean;
    precision: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    qualifiedName?: string;
    ideUri?: string;
    fallbackSearchQuery?: string;
  }> {
    const res = await fetch(`${BASE}/source-bindings/${bindingId}/resolve`);
    if (!res.ok) throw new Error(`wiki/resolve failed: ${res.status}`);
    return res.json();
  },
};
