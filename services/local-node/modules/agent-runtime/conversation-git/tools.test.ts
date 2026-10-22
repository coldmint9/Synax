import { beforeEach, describe, expect, it, vi } from 'vitest';
const service=vi.hoisted(()=>({create:vi.fn(),get:vi.fn(),list:vi.fn(),file:vi.fn(),propose:vi.fn(),action:vi.fn()}));
vi.mock('./service.js',()=>({conversationGitService:service}));
import { conversationGitTools } from './tools.js';
import type { ToolExecutionInput } from '../contracts.js';
const execute=(id:string,args:unknown)=>conversationGitTools.find(tool=>tool.id===id)!.execute({sessionId:'s',runId:'r',stepId:'st',toolCallId:'call',toolId:id,category:'task',mutability:'task',args} as ToolExecutionInput);
const snapshot={reference:{objectId:'task'},task:{id:'task',revision:1},mr:{id:'mr',title:'Merge',status:'draft',version:1,target:'main',targetOid:'a',steps:[],checks:[],checkResults:[]},stale:false,files:[],proposals:[]};
beforeEach(()=>vi.clearAllMocks());
describe('conversation native Git tools',()=>{
 it('creates only a reviewable draft with a stable idempotency key',async()=>{
  service.create.mockResolvedValue(snapshot);
  const args={title:'Merge',target:'main',sources:['feature/x']};
  await execute('git.merge.create',args);await execute('git.merge.create',args);
  expect(service.create.mock.calls[0][1].requestId).toBe(service.create.mock.calls[1][1].requestId);
  expect(service.create.mock.calls[0][0]).toBe('s');expect(service.create.mock.calls[0][1].autoFinalize).toBeUndefined();
  await expect(execute('git.merge.create',{...args,autoFinalize:true})).rejects.toThrow();
 });
 it('analyzes only in an isolated worktree and binds both versions',async()=>{
  service.action.mockResolvedValue(snapshot);
  await execute('git.merge.analyze',{objectId:'task',expectedVersion:1,expectedTaskRevision:1});
  expect(service.action).toHaveBeenCalledWith('s','task',expect.objectContaining({action:'prepare',expectedVersion:1,expectedTaskRevision:1}));
 });
 it('reads only task/file ids in the current session',async()=>{
  service.list.mockResolvedValue([snapshot]);service.file.mockResolvedValue({revision:'r1',base:'base',target:'a',source:'b',result:'result'});
  await execute('git.merge.read',{});expect(service.list).toHaveBeenCalledWith('s');
  await execute('git.merge.read',{objectId:'task',fileId:'file'});expect(service.file).toHaveBeenCalledWith('s','task','file');
  await expect(execute('git.merge.read',{fileId:'file'})).rejects.toThrow();
 });
 it('stores a proposal without exposing apply/check/finalize tools',async()=>{
  service.propose.mockResolvedValue({id:'proposal'});
  await execute('git.merge.propose',{objectId:'task',fileId:'file',revision:'r1',content:'combined',rationale:'Preserves both branches'});
  expect(service.propose).toHaveBeenCalledWith('s','task',{fileId:'file',revision:'r1',content:'combined',rationale:'Preserves both branches'});
  expect(conversationGitTools.map(tool=>tool.id)).toEqual(['git.merge.create','git.merge.analyze','git.merge.read','git.merge.propose']);
 });
});
