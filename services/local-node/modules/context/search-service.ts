import { contextService } from './context-service.js';
import type { SearchFilter, SearchHit } from '../contracts/context.js';
export class SearchService {
  searchMemories(projectId: string, query: string, filter: SearchFilter = {}): SearchHit[] {
    const terms = query.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const now = new Date().toISOString();
    return contextService.allMemories(projectId).filter(m => m.status === 'active' && (!m.expiresAt || m.expiresAt > now) && (!filter.memoryType || m.memoryType === filter.memoryType))
      .map(m => {
        const text = `${m.title}\n${m.content}`.normalize('NFKC').toLocaleLowerCase();
        const hits = terms.filter(t => text.includes(t)).length;
        return {kind:'memory' as const,id:m.id,projectId,title:m.title,snippet:m.content.slice(0,240),score:hits ? hits / terms.length + m.confidence * .1 : 0,createdAt:m.createdAt};
      }).filter(hit => hit.score > 0).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id)).slice(0,Math.min(100,Math.max(1,filter.limit ?? 20)));
  }
}
export const searchService = new SearchService();
