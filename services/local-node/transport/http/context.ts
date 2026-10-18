import { Hono } from 'hono';
import { z } from 'zod';
import { contextService } from '../../modules/context/context-service.js';
import { memoryManager } from '../../modules/context/memory-manager.js';
import { searchService } from '../../modules/context/search-service.js';
export const contextRoutes = new Hono();
const memoryType = z.enum(['pattern','decision','preference','convention','insight','risk']);
const fields = { memoryType, title:z.string().min(1).max(200), content:z.string().min(1).max(20000), tags:z.array(z.string().max(64)).max(32).optional(), confidence:z.number().min(0).max(1).optional(), references:z.record(z.string(),z.unknown()).optional() };
contextRoutes.use('*', async (_c,next) => { await contextService.hydrate(); await next(); await contextService.flush(); });
contextRoutes.get('/memories', c => {
  const query = z.object({ projectId:z.string().min(1), memoryType:memoryType.optional(),status:z.enum(['active','archived','superseded']).optional(),tag:z.string().optional(),limit:z.coerce.number().int().min(1).max(500).optional(),offset:z.coerce.number().int().nonnegative().optional() }).safeParse(c.req.query());
  if(!query.success) return c.json({error:'Invalid memory query'},400);
  return c.json(contextService.listMemories(query.data.projectId,query.data));
});
contextRoutes.post('/memories',async c => {
  const input=z.object({projectId:z.string().min(1).max(128),...fields}).safeParse(await c.req.json());
  if(!input.success) return c.json({error:'Invalid memory'},400);
  return c.json(contextService.createMemory(input.data.projectId,input.data),201);
});
contextRoutes.post('/memories/relevant',async c => {
  const input=z.object({projectId:z.string().min(1),currentContext:z.string().min(1).max(5000),topK:z.number().int().min(1).max(20).default(5)}).safeParse(await c.req.json());
  if(!input.success) return c.json({error:'Invalid query'},400);
  return c.json({items:memoryManager.getRelevantMemories(input.data.projectId,input.data.currentContext,input.data.topK)});
});
contextRoutes.get('/memories/:id', c => { const m=contextService.getMemory(c.req.param('id'));return m ? c.json(m):c.json({error:'Not found'},404); });
contextRoutes.patch('/memories/:id',async c => {
  const patch=z.object({...fields,status:z.enum(['active','archived','superseded'])}).partial().safeParse(await c.req.json());
  if(!patch.success) return c.json({error:'Invalid memory'},400);
  if(!contextService.getMemory(c.req.param('id'))) return c.json({error:'Not found'},404);
  return c.json(contextService.updateMemory(c.req.param('id'),patch.data));
});
contextRoutes.delete('/memories/:id', c => {contextService.deleteMemory(c.req.param('id'));return c.json({ok:true});});
contextRoutes.post('/search',async c => {
  const input=z.object({projectId:z.string().min(1),query:z.string().min(1).max(500),limit:z.number().int().min(1).max(100).optional()}).safeParse(await c.req.json());
  if(!input.success) return c.json({error:'Invalid query'},400);
  return c.json({items:searchService.searchMemories(input.data.projectId,input.data.query,input.data)});
});
