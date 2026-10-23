import { createHash } from 'node:crypto';
import type { RegisteredTool } from '../contracts.js';
import { conversationGitService } from './service.js';
import { conversationGitInputSchema, conversationGitProposalSchema, conversationGitReadSchema, conversationGitAnalyzeSchema, conversationGitConfigureSchema } from './schemas.js';
import type { ConversationGitSnapshot } from './contracts.js';

function compact(snapshot: ConversationGitSnapshot) {
  const { mr, task, reference, stale, staleReason, files, proposals } = snapshot;
  return { reference, objectId:task.id, taskRevision:task.revision, execution:snapshot.execution, mr:{id:mr.id,title:mr.title,status:mr.status,version:mr.version,target:mr.target,targetOid:mr.targetOid,steps:mr.steps,candidateOid:mr.candidateOid,candidateTree:mr.candidateTree,checks:mr.checks,checkResults:mr.checkResults.map(result=>({...result,output:result.output.slice(-12000)})),error:mr.error},stale,staleReason,files,proposals:proposals.map(({content,...proposal})=>({...proposal,characters:content.length})) };
}
function workerReceipt(snapshot:ConversationGitSnapshot) {
  return { reference:snapshot.reference, objectId:snapshot.task.id, taskRevision:snapshot.task.revision, execution:snapshot.execution,
    mr:{id:snapshot.mr.id,status:snapshot.mr.status,version:snapshot.mr.version,target:snapshot.mr.target,candidateOid:snapshot.mr.candidateOid},
    summary:snapshot.execution?.summary, error:snapshot.execution?.error };
}
async function runWorker(sessionId:string, objectId:string, signal?:AbortSignal) {
  const { startConversationMergeWorker, waitForConversationMergeWorker } = await import('./worker.js');
  const snapshot = await startConversationMergeWorker(sessionId, objectId);
  await waitForConversationMergeWorker(sessionId, snapshot, signal);
  return conversationGitService.get(sessionId, objectId);
}
export const conversationGitTools: RegisteredTool[] = [
  {
    id:'git.merge.create', label:'Create interactive merge task', category:'task', internalGate:'none', mutability:'task', resumeBehavior:'auto',
    description:'Create a persistent Git merge task in this conversation and delegate its isolated merge work to a dedicated child agent. Waits for a terminal summary or an explicit asynchronous handoff from the child; child source code and transcript remain isolated. Reuse git.merge.read for existing tasks.',
    progressiveDetails:'Use only within the user-authorized merge scope. Source/target must be local branches in a registered session root. Supply grounded verification commands; the worker never skips verification, pushes remote branches, or deletes source branches. The card provides stop, continue and cancel controls. Do not copy the child transcript into the parent context.',
    inputSchema:conversationGitInputSchema,
    async execute(input){
      const args=conversationGitInputSchema.parse(input.args);
      const created=await conversationGitService.create(input.sessionId,{...args,requestId:`tool_${createHash('sha256').update(input.toolCallId).digest('hex')}`},{runId:input.runId??undefined,stepId:input.stepId??undefined,toolCallId:input.toolCallId});
      const snapshot=await runWorker(input.sessionId,created.task.id,input.abortSignal);
      return {result:workerReceipt(snapshot),displaySummary:`智能合并任务：${snapshot.execution?.summary??snapshot.mr.status}`,artifacts:[]};
    },
  },
  {
    id:'git.merge.analyze',label:'Analyze merge in an isolated worktree',category:'write',internalGate:'write',mutability:'write',resumeBehavior:'none',
    description:'Start the dedicated merge child for an existing draft task. The child owns all internal merge steps and returns only a bounded summary to this conversation.',
    inputSchema:conversationGitAnalyzeSchema,
    async execute(input){
      const {objectId}=conversationGitAnalyzeSchema.parse(input.args);
      const snapshot=await runWorker(input.sessionId,objectId,input.abortSignal);
      return {result:workerReceipt(snapshot),displaySummary:`智能合并任务：${snapshot.execution?.summary??snapshot.mr.status}`,artifacts:[]};
    },
  },
  {
    id:'git.merge.configure',label:'Configure merge verification',category:'task',internalGate:'none',mutability:'task',resumeBehavior:'auto',
    description:'Set grounded verification commands for a stopped or waiting merge task. Use after the worker reports missing verification. This changes configuration only; the user can Continue the same card afterward.',
    inputSchema:conversationGitConfigureSchema,
    async execute(input){
      const {objectId,...args}=conversationGitConfigureSchema.parse(input.args);
      const snapshot=await conversationGitService.configureChecks(input.sessionId,objectId,{...args,requestId:`tool_${createHash('sha256').update(input.toolCallId).digest('hex')}`});
      return {result:compact(snapshot),displaySummary:'已更新验证配置，可以继续原合并任务。',artifacts:[]};
    },
  },
  {
    id:'git.merge.read',label:'Inspect conversation merge task',category:'read',internalGate:'none',mutability:'read',resumeBehavior:'auto',
    description:'Read persistent Git merge tasks owned by this conversation. Omit objectId to list tasks; provide objectId for status/files/proposals and fileId for content. Small files use character offset/limit. When contentState is partial, use side, byteOffset=nextByteOffset and expectedRevision to read bounded byte pages; never treat a preview as a complete file. Does not execute Git writes.',
    inputSchema:conversationGitReadSchema,
    async execute(input){
      const args=conversationGitReadSchema.parse(input.args);
      let result:unknown;
      if(!args.objectId)result=(await conversationGitService.list(input.sessionId)).slice(0,20).map(compact);
      else if(args.fileId && args.side && args.byteOffset !== undefined && args.expectedRevision){
        const page=await conversationGitService.fileSlice(input.sessionId,args.objectId,args.fileId,{side:args.side,byteOffset:args.byteOffset,maxBytes:Math.max(4,args.limit),expectedRevision:args.expectedRevision},input.abortSignal);
        result={fileId:args.fileId,side:args.side,...page,contentState:'partial',editable:false,truncated:!page.eof};
      }
      else if(args.fileId){
        const file=await conversationGitService.file(input.sessionId,args.objectId,args.fileId);
        if(args.side&&file.truncatedSides?.includes(args.side)){
          const page=await conversationGitService.fileSlice(input.sessionId,args.objectId,args.fileId,{side:args.side,byteOffset:args.offset,maxBytes:Math.max(4,args.limit),expectedRevision:file.revision},input.abortSignal);
          result={fileId:file.id,path:file.path,side:args.side,...page,offsetUnit:'bytes',contentState:file.contentState,editable:file.editable,truncated:!page.eof};
        }
        else if(args.side){const content=file[args.side];result={fileId:file.id,path:file.path,revision:file.revision,side:args.side,offset:args.offset,content:content.slice(args.offset,args.offset+args.limit),totalCharacters:content.length,totalBytes:file.byteSizes?.[args.side],contentState:file.contentState,editable:file.editable,truncated:args.offset+args.limit<content.length};}
        else {const {resolutionState:_state,...summary}=file;result={...summary,base:file.base.slice(0,args.limit),target:file.target.slice(0,args.limit),source:file.source.slice(0,args.limit),result:file.result.slice(0,args.limit),truncated:file.contentState==='partial'||[file.base,file.target,file.source,file.result].some(value=>value.length>args.limit),limit:args.limit};}
      }else result=compact(await conversationGitService.get(input.sessionId,args.objectId));
      return {result,displaySummary:'已读取当前会话的合并任务。',artifacts:[]};
    },
  },
  {
    id:'git.merge.propose',label:'Propose inline conflict resolution',category:'task',internalGate:'none',mutability:'task',resumeBehavior:'auto',
    description:'Save a reviewable text resolution proposal on an existing conversation merge task. Read the exact file/revision with git.merge.read first. Explain how both branch intentions are preserved. The proposal updates the same inline card; it does not apply files, run checks or merge. The user chooses whether to apply it.',
    inputSchema:conversationGitProposalSchema,
    async execute(input){
      const {objectId,...proposal}=conversationGitProposalSchema.parse(input.args);
      const result=await conversationGitService.propose(input.sessionId,objectId,proposal);
      return {result:{objectId,...result},displaySummary:`已更新任务卡中的解决建议：${proposal.rationale.slice(0,180)}`,artifacts:[]};
    },
  },
];
