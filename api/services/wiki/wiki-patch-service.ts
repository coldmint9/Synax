// ---------------------------------------------------------------------------
// api/services/wiki/wiki-patch-service.ts — stub (patch queue removed)
// ---------------------------------------------------------------------------

export class WikiPatchConflictError extends Error {
  constructor(public readonly documentId: string, public readonly manualState: string) {
    super(`Document ${documentId} has manualState=${manualState}. Pass confirmManualOverride=true to proceed.`);
    this.name = 'WikiPatchConflictError';
  }
}

export const wikiPatchService = {
  async getPatch(_patchId: string) {
    return null;
  },

  async accept(_patchId: string, _opts?: { actorId?: string; confirmManualOverride?: boolean }) {
    throw new Error('Wiki patch queue has been removed');
  },

  async dismiss(_patchId: string, _opts?: { actorId?: string }) {
    throw new Error('Wiki patch queue has been removed');
  },
};
