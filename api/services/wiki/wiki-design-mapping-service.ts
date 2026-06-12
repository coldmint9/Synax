// ---------------------------------------------------------------------------
// api/services/wiki/wiki-design-mapping-service.ts — stub (removed with block model)
// ---------------------------------------------------------------------------

const REMOVED = 'Wiki design mapping has been removed';

export const wikiDesignMappingService = {
  async plan(_input: unknown) {
    throw new Error(REMOVED);
  },

  async confirm(_taskId: string, _opts?: unknown) {
    throw new Error(REMOVED);
  },

  async getTask(_taskId: string) {
    return null;
  },
};
