import { Hono } from 'hono';
import { ZodError } from 'zod/v4';
import { conversationGitService, type ConversationGitService } from '../../modules/agent-runtime/conversation-git/service.js';
import { conversationGitActionSchema, conversationGitApplySchema, conversationGitCreateSchema, conversationGitSaveSchema } from '../../modules/agent-runtime/conversation-git/schemas.js';
import { GitMrError } from '../../modules/git-mr/errors.js';
import { AgentRuntimeError } from '../../modules/agent-runtime/runtime-errors.js';
import { assertHistoryUnlocked } from '../../modules/agent-runtime/runtime-history.js';

/** Mounted under the runtime session guards: the owner always comes from the URL. */
export function createConversationGitRoutes(service: ConversationGitService = conversationGitService) {
  const routes = new Hono();
  routes.onError((error,c) => {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({error:'Invalid conversation Git task input.',code:'INVALID_INPUT'},400);
    if (error instanceof GitMrError)
      return c.json({error:error.message,code:error.code},error.status as 400|403|404|409|500);
    if (error instanceof AgentRuntimeError)
      return c.json({error:error.message,code:error.code},error.status as 400|403|404|409|500);
    return c.json({error:error.message,code:'CONVERSATION_GIT_ERROR'},500);
  });
  routes.use('*', async(c,next)=>{
    if(c.req.method!=='GET')assertHistoryUnlocked(c.req.param('sessionId')!);
    await next();
  });
  routes.get('/',async c=>c.json(await service.list(c.req.param('sessionId')!)));
  routes.post('/create',async c=>c.json(await service.create(c.req.param('sessionId')!,conversationGitCreateSchema.parse(await c.req.json())),201));
  routes.get('/:objectId',async c=>c.json(await service.get(c.req.param('sessionId')!,c.req.param('objectId'))));
  routes.get('/:objectId/files/:fileId',async c=>c.json(await service.file(c.req.param('sessionId')!,c.req.param('objectId'),c.req.param('fileId'))));
  routes.post('/:objectId/actions',async c=>c.json(await service.action(c.req.param('sessionId')!,c.req.param('objectId'),conversationGitActionSchema.parse(await c.req.json()))));
  routes.put('/:objectId/files/:fileId',async c=>c.json(await service.saveFile(c.req.param('sessionId')!,c.req.param('objectId'),c.req.param('fileId'),conversationGitSaveSchema.parse(await c.req.json()))));
  routes.post('/:objectId/proposals/apply',async c=>c.json(await service.applyProposal(c.req.param('sessionId')!,c.req.param('objectId'),conversationGitApplySchema.parse(await c.req.json()))));
  return routes;
}
