import { contextService } from './context-service.js';
import { searchService } from './search-service.js';
import type { ProjectMemory } from '../contracts/context.js';
export const memoryManager = {
  getRelevantMemories(projectId: string, query: string, limit = 5): ProjectMemory[] {
    return searchService.searchMemories(projectId, query, {limit}).flatMap(hit => {
      const memory = contextService.getMemory(hit.id); return memory ? [memory] : [];
    });
  },
};
