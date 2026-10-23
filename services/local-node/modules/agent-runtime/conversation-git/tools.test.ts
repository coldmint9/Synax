import { beforeEach, describe, expect, it, vi } from 'vitest';
const service=vi.hoisted(()=>({create:vi.fn(),get:vi.fn(),list:vi.fn(),file:vi.fn(),fileSlice:vi.fn(),propose:vi.fn(),action:vi.fn(),configureChecks:vi.fn()}));
vi.mock('./service.js',()=>({conversationGitService:service}));
const worker=vi.hoisted(()=>({startConversationMergeWorker:vi.fn(),waitForConversationMergeWorker:vi.fn()}));
vi.mock('./worker.js',()=>worker);
import { conversationGitTools } from './tools.js';
import type { ToolExecutionInput } from '../contracts.js';
const execute=(id:string,args:unknown)=>conversationGitTools.find(tool=>tool.id===id)!.execute({sessionId:'s',runId:'r',stepId:'st',toolCallId:'call',toolId:id,category:'task',mutability:'task',args} as ToolExecutionInput);
const snapshot={reference:{objectId:'task'},task:{id:'task',revision:1},mr:{id:'mr',title:'Merge',status:'draft',version:1,target:'main',targetOid:'a',steps:[],checks:[],checkResults:[]},stale:false,files:[],proposals:[]};
beforeEach(()=>{vi.clearAllMocks();worker.startConversationMergeWorker.mockResolvedValue(snapshot);worker.waitForConversationMergeWorker.mockResolvedValue(snapshot);service.get.mockResolvedValue(snapshot);});
describe('conversation native Git tools',()=>{
 it('creates a stable task then delegates its work without duplicating the card',async()=>{
  service.create.mockResolvedValue(snapshot);
  const args={title:'Merge',target:'main',sources:['feature/x']};
  await execute('git.merge.create',args);await execute('git.merge.create',args);
  expect(service.create.mock.calls[0][1].requestId).toBe(service.create.mock.calls[1][1].requestId);
  expect(service.create.mock.calls[0][0]).toBe('s');expect(service.create.mock.calls[0][1].autoFinalize).toBeUndefined();
  expect(worker.startConversationMergeWorker).toHaveBeenCalledWith('s','task');
  expect(worker.waitForConversationMergeWorker).toHaveBeenCalledWith('s',snapshot,undefined);
  await expect(execute('git.merge.create',{...args,autoFinalize:true})).rejects.toThrow();
 });
 it('analyzes through the dedicated worker instead of performing Git work in the parent',async()=>{
  service.action.mockResolvedValue(snapshot);
  await execute('git.merge.analyze',{objectId:'task',expectedVersion:1,expectedTaskRevision:1});
  expect(worker.startConversationMergeWorker).toHaveBeenCalledWith('s','task');
  expect(service.action).not.toHaveBeenCalled();
 });
 it('reads only task/file ids in the current session',async()=>{
  service.list.mockResolvedValue([snapshot]);service.file.mockResolvedValue({revision:'r1',base:'base',target:'a',source:'b',result:'result'});
  await execute('git.merge.read',{});expect(service.list).toHaveBeenCalledWith('s');
  await execute('git.merge.read',{objectId:'task',fileId:'file'});expect(service.file).toHaveBeenCalledWith('s','task','file');
  await expect(execute('git.merge.read',{fileId:'file'})).rejects.toThrow();
 });
 it('never reports a large file preview as complete and pages by byte cursor',async()=>{
  service.file.mockResolvedValue({id:'file',path:'large.java',revision:'r1',base:'base',target:'preview',source:'source',result:'preview',contentState:'partial',editable:false,truncatedSides:['result'],byteSizes:{result:24*1024*1024}});
  service.fileSlice.mockResolvedValue({content:'bounded page',byteOffset:0,nextByteOffset:12,totalBytes:24*1024*1024,eof:false,revision:'r1'});
  const first=await execute('git.merge.read',{objectId:'task',fileId:'file',side:'result'});
  expect(first.result).toMatchObject({truncated:true,contentState:'partial',editable:false,totalBytes:24*1024*1024,nextByteOffset:12});
  expect(first.result).not.toHaveProperty('totalCharacters');
  await execute('git.merge.read',{objectId:'task',fileId:'file',side:'result',byteOffset:12,expectedRevision:'r1'});
  expect(service.fileSlice).toHaveBeenLastCalledWith('s','task','file',expect.objectContaining({byteOffset:12,expectedRevision:'r1'}),undefined);
 });
 it('stores a proposal without exposing apply/check/finalize tools',async()=>{
  service.propose.mockResolvedValue({id:'proposal'});
  await execute('git.merge.propose',{objectId:'task',fileId:'file',revision:'r1',content:'combined',rationale:'Preserves both branches'});
  expect(service.propose).toHaveBeenCalledWith('s','task',{fileId:'file',revision:'r1',content:'combined',rationale:'Preserves both branches'});
  expect(conversationGitTools.map(tool=>tool.id)).toEqual(['git.merge.create','git.merge.analyze','git.merge.configure','git.merge.read','git.merge.propose']);
 });
});
