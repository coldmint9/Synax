import { randomUUID } from 'node:crypto';
import { businessStore } from '../../infrastructure/persistence/business-store.js';
import type { MemoryFilter, NewMemory, ProjectMemory, ContextBlock, ContextBinding } from '../contracts/context.js';

/** Project memory complements the Agent's Rust transcript. The obsolete second
 * context-session/coordinate graph has been removed. */
export class ContextService {
  hydrate() { return businessStore.refresh(['memories']); }
  flush() { return businessStore.flush(['memories']); }
  createMemory(projectId: string, input: NewMemory): ProjectMemory {
    const now = new Date().toISOString();
    const memory: ProjectMemory = { id: `mem_${randomUUID()}`, projectId,
      memoryType: input.memoryType, title: input.title, content: input.content,
      sourceSessionId: input.sourceSessionId ?? null, sourceEntryId: input.sourceEntryId ?? null,
      tags: input.tags ?? [], confidence: input.confidence ?? 0.7, accessCount: 0,
      references: input.references ?? {}, status: 'active', createdAt: now, updatedAt: now,
      expiresAt: input.expiresAt ?? null };
    businessStore.put('memories', memory.id, memory); return memory;
  }
  getMemory(id: string): ProjectMemory | null { return businessStore.get<ProjectMemory>('memories', id) ?? null; }
  allMemories(projectId: string): ProjectMemory[] { return businessStore.list<ProjectMemory>('memories').filter(m => m.projectId === projectId); }
  listMemories(projectId: string, filter: MemoryFilter = {}) {
    const offset = Math.max(0, filter.offset ?? 0), limit = Math.min(500, Math.max(1, filter.limit ?? 50));
    const rows = this.allMemories(projectId).filter(m => (!filter.memoryType || m.memoryType === filter.memoryType) &&
      (!filter.status || m.status === filter.status) && (!filter.tag || m.tags.includes(filter.tag)))
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
  }
  updateMemory(id: string, patch: Partial<Pick<ProjectMemory, 'title'|'content'|'tags'|'confidence'|'status'|'memoryType'|'references'>>): ProjectMemory {
    const before = this.getMemory(id); if (!before) throw new Error(`Memory ${id} not found`);
    const next = {...before, ...patch, updatedAt: new Date().toISOString()};
    businessStore.put('memories', id, next); return next;
  }
  touchMemory(id: string): void {
    const memory = this.getMemory(id); if (!memory) return;
    businessStore.put('memories', id, {...memory, accessCount: memory.accessCount + 1});
  }
  deleteMemory(id: string): void { businessStore.delete('memories', id); }
  suggestContextBlocks(input: {projectId:string;nodeId?:string|null;runId?:string|null;limit?:number}): Array<{block:ContextBlock;relation:ContextBinding['relation'];score:number;reason:string}> {
    return this.listMemories(input.projectId,{status:'active',limit:input.limit ?? 8}).items.map(m => ({
      block:{id:m.id,projectId:m.projectId,kind:'memory',title:m.title,content:m.content,status:'active',sourceType:'memory',sourceId:m.id,metadata:{references:m.references},createdAt:m.createdAt,updatedAt:m.updatedAt,createdBy:null},
      relation:m.memoryType === 'risk' ? 'constrains':'references',score:m.confidence,reason:'project memory',
    }));
  }
}
export const contextService = new ContextService();
