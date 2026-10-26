import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../modules/agent-runtime/runtime-history.js',()=>({assertHistoryUnlocked:vi.fn()}));
vi.mock('../../../modules/agent-runtime/conversation-git/service.js',()=>({conversationGitService:{}}));
import { createConversationGitRoutes } from '../conversation-git.js';
import { GitMrError } from '../../../modules/git-mr/errors.js';
import type { ConversationGitService } from '../../../modules/agent-runtime/conversation-git/service.js';
function fixture(){
 const service={list:vi.fn().mockResolvedValue([]),create:vi.fn().mockResolvedValue({reference:{objectId:'task'},task:{id:'task'}}),startWorker:vi.fn().mockResolvedValue({reference:{objectId:'task'},task:{id:'task'}}),get:vi.fn().mockResolvedValue({}),file:vi.fn().mockResolvedValue({}),fileSlice:vi.fn().mockResolvedValue({content:'page',byteOffset:0,nextByteOffset:4,totalBytes:4,eof:true,revision:'r1'}),action:vi.fn().mockResolvedValue({}),saveFile:vi.fn().mockResolvedValue({}),applyProposal:vi.fn().mockResolvedValue({})};
 const app=new Hono();app.route('/sessions/:sessionId/git-tasks',createConversationGitRoutes(service as unknown as ConversationGitService));
 return {app,service};
}
const json=(body:unknown,method='POST')=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const input={requestId:'request-1',title:'Merge auth',target:'main',sources:['feature/auth'],strategy:'merge_commit'};
describe('conversation Git HTTP boundary',()=>{
 it('reads bounded content pages with scope, revision and cancellation signal', async()=>{
  const {app,service}=fixture();
  const url='/sessions/owner/git-tasks/task/files/file/content?side=result&byteOffset=0&maxBytes=65536&expectedRevision=r1';
  expect((await app.request(url)).status).toBe(200);
  expect(service.fileSlice).toHaveBeenCalledWith('owner','task','file',{side:'result',byteOffset:0,maxBytes:65536,expectedRevision:'r1'},expect.any(AbortSignal));
  expect((await app.request(url.replace('65536','999999999'))).status).toBe(400);
  expect((await app.request(url.replace('&expectedRevision=r1',''))).status).toBe(400);
  expect(service.fileSlice).toHaveBeenCalledTimes(1);
 });
 it('binds creation and reads to URL owner, never accepts caller project/path/autoFinalize',async()=>{
  const {app,service}=fixture();
  expect((await app.request('/sessions/owner/git-tasks/create',json(input))).status).toBe(201);
  expect(service.create).toHaveBeenCalledWith('owner',input);
  expect(service.startWorker).toHaveBeenCalledWith('owner','task');
  for(const extra of [{projectId:'other'},{repository:'/other'},{sessionId:'other'},{autoFinalize:true}]){
   expect((await app.request('/sessions/owner/git-tasks/create',json({...input,...extra}))).status).toBe(400);
  }
  expect(service.create).toHaveBeenCalledTimes(1);
  await app.request('/sessions/owner/git-tasks/task');
  expect(service.get).toHaveBeenCalledWith('owner','task');
 });
 it('requires every concurrency token on mutating actions',async()=>{
  const {app,service}=fixture();
  const action={action:'finalize',requestId:'action-1',expectedVersion:7,expectedTaskRevision:2};
  expect((await app.request('/sessions/s/git-tasks/t/actions',json(action))).status).toBe(200);
  expect(service.action).toHaveBeenCalledWith('s','t',action);
  for(const key of ['requestId','expectedVersion','expectedTaskRevision']){
   const partial={...action};delete partial[key as keyof typeof partial];
   expect((await app.request('/sessions/s/git-tasks/t/actions',json(partial))).status).toBe(400);
  }
  expect(service.action).toHaveBeenCalledTimes(1);
 });
 it('validates file saves and preserves domain stale errors',async()=>{
  const {app,service}=fixture();
  const save={requestId:'save',expectedVersion:2,expectedTaskRevision:1,expectedRevision:'file-r1',resolve:false,content:'draft'};
  expect((await app.request('/sessions/s/git-tasks/t/files/f',json(save,'PUT'))).status).toBe(200);
  expect(service.saveFile).toHaveBeenCalledWith('s','t','f',save);
  expect((await app.request('/sessions/s/git-tasks/t/files/f',json({...save,choice:'source'},'PUT'))).status).toBe(400);
  service.action.mockRejectedValue(new GitMrError('Target moved','STALE_PLAN'));
  const response=await app.request('/sessions/s/git-tasks/t/actions',json({action:'prepare',requestId:'go',expectedVersion:1,expectedTaskRevision:1}));
  expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'Target moved',code:'STALE_PLAN'});
 });
 it('rejects arbitrary actions and invalid check commands',async()=>{
  const {app,service}=fixture();
  expect((await app.request('/sessions/s/git-tasks/t/actions',json({action:'push',requestId:'x',expectedVersion:1,expectedTaskRevision:1}))).status).toBe(400);
  expect((await app.request('/sessions/s/git-tasks/create',json({...input,checks:[{id:'x',executable:'node\0bad',args:[],timeoutMs:1000}]}))).status).toBe(400);
  expect(service.action).not.toHaveBeenCalled();expect(service.create).not.toHaveBeenCalled();
 });
});
