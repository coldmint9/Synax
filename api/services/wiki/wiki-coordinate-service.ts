// ---------------------------------------------------------------------------
// api/services/wiki/wiki-coordinate-service.ts — stub (block bindings removed)
// ---------------------------------------------------------------------------

export interface CoordinateResolution {
  resolved: boolean;
  precision: 'file' | 'symbol' | 'chunk';
  filePath?: string;
  startLine?: number;
  endLine?: number;
  qualifiedName?: string;
  ideUri?: string;
  fallbackSearchQuery?: string;
}

export function buildLocator(): null {
  return null;
}

export const wikiCoordinateService = {
  async resolveBinding(bindingId: string): Promise<CoordinateResolution> {
    return {
      resolved: false,
      precision: 'file',
      fallbackSearchQuery: bindingId,
    };
  },

  async detectChangedBindings(_projectId: string, _codeIndex: unknown) {
    return { changedBindingIds: [] as string[], changedSourceIds: [] as string[] };
  },

  async getBlockIdsBySourceIds(_projectId: string, _repoIndexId: string, _sourceIds: string[]) {
    return new Map<string, string[]>();
  },

  async getBlockIdsByBindingIds(_bindingIds: string[]) {
    return [] as string[];
  },

  async refreshVerifiedHashes(_projectId: string, _repoIndexId: string, _codeIndex: unknown) {
    // no-op
  },

  async createBindingsFromLinks() {
    // no-op
  },
};
