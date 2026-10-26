import { createHash } from 'node:crypto';
import type { RegisteredTool } from '../contracts.js';
import { conversationGitService } from './service.js';
import { conversationGitInputSchema, conversationGitProposalSchema, conversationGitReadSchema, conversationGitAnalyzeSchema, conversationGitConfigureSchema, conversationGitResumeSchema, conversationGitCancelSchema } from './schemas.js';
import type { ConversationGitSnapshot } from './contracts.js';

function compact(snapshot: ConversationGitSnapshot) {
  const { mr, task, reference, stale, staleReason, files, proposals } = snapshot;
  return { reference, objectId:task.id, taskRevision:task.revision, execution:snapshot.execution, mr:{id:mr.id,title:mr.title,status:mr.status,version:mr.version,target:mr.target,targetOid:mr.targetOid,steps:mr.steps,candidateOid:mr.candidateOid,candidateTree:mr.candidateTree,checks:mr.checks,checkResults:mr.checkResults.map(result=>({...result,output:result.output.slice(-12000)})),error:mr.error},stale,staleReason,files,proposals:proposals.map(({content,...proposal})=>({...proposal,characters:content.length})) };
}
function workerReceipt(snapshot:ConversationGitSnapshot) {
  return { reference:snapshot.reference, objectId:snapshot.task.id, taskRevision:snapshot.task.revision, execution:snapshot.execution,
    mr:{id:snapshot.mr.id,status:snapshot.mr.status,version:snapshot.mr.version,target:snapshot.mr.target,candidateOid:snapshot.mr.candidateOid},
    summary:snapshot.execution?.summary, error:snapshot.execution?.error,
    ...(['failed', 'recovery_required', 'waiting_user', 'paused'].includes(snapshot.execution?.status ?? '')
      ? { nextTool: 'git.merge.resume', nextArgs: { objectId: snapshot.task.id } } : {}) };
}
async function runWorker(sessionId:string, objectId:string, signal?:AbortSignal, resume?: { instructions?: string }) {
  const { startConversationMergeWorker, resumeConversationMergeWorker, waitForConversationMergeWorker } = await import('./worker.js');
  let snapshot = resume
    ? await resumeConversationMergeWorker(sessionId, objectId, resume.instructions)
    : await startConversationMergeWorker(sessionId, objectId);
  // One automatic re-entry per invocation. Persistent failures return a bounded
  // receipt to the agent instead of spinning or reopening a user stop.
  for (let attempt = 0; ; attempt++) {
    snapshot = await waitForConversationMergeWorker(sessionId, snapshot, signal);
    snapshot = await conversationGitService.get(sessionId, objectId);
    if (attempt >= 1 || signal?.aborted || snapshot.stale || snapshot.execution?.stopRequested ||
        !['failed', 'recovery_required'].includes(snapshot.execution?.status ?? '')) return snapshot;
    snapshot = await resumeConversationMergeWorker(sessionId, objectId, resume?.instructions);
  }
}
export const conversationGitTools: RegisteredTool[] = [
  {
    id:'git.merge.create', label:'Create interactive merge task', category:'task', internalGate:'none', mutability:'task', resumeBehavior:'auto',
    description:'Create a persistent Git merge task in this conversation and delegate its isolated merge work to a dedicated child agent. Waits for a terminal summary or an explicit asynchronous handoff from the child; child source code and transcript remain isolated. Use git.merge.read and git.merge.resume for existing tasks instead of creating another task.',
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
    id:'git.merge.analyze',label:'Analyze merge in an isolated worktree',category:'write',internalGate:'write',mutability:'write',resumeBehavior:'auto',
    description:'Start or re-enter the dedicated merge child for an existing task. Joins an active worker and automatically recovers failed/interrupted workers using the same task and isolated candidate. The child returns only a bounded summary. Use git.merge.resume to continue a paused/waiting task or pass new user decisions.',
    inputSchema:conversationGitAnalyzeSchema,
    async execute(input){
      const {objectId}=conversationGitAnalyzeSchema.parse(input.args);
      const snapshot=await runWorker(input.sessionId,objectId,input.abortSignal);
      return {result:workerReceipt(snapshot),displaySummary:`智能合并任务：${snapshot.execution?.summary??snapshot.mr.status}`,artifacts:[]};
    },
  },
  {
    id:'git.merge.resume',label:'Resume an existing merge task',category:'write',internalGate:'write',mutability:'write',resumeBehavior:'auto',
    description:'Re-enter an existing merge task after interruption, failure or user input. Reuses the same task, child and isolated candidate; joins an already active worker and returns completed/cancelled tasks unchanged. Pass the current user decisions in instructions. Within the authorized merge scope, resume recoverable failures automatically instead of asking the user to click Continue or recreate the task. Respect explicit user stops; resume paused tasks only when continuation is requested.',
    inputSchema:conversationGitResumeSchema,
    async execute(input){
      const {objectId,instructions}=conversationGitResumeSchema.parse(input.args);
      const snapshot=await runWorker(input.sessionId,objectId,input.abortSignal,{instructions});
      return {result:workerReceipt(snapshot),displaySummary:`智能合并任务：${snapshot.execution?.summary??snapshot.mr.status}`,artifacts:[]};
    },
  },
  {
    id:'git.merge.cancel',label:'Cancel an existing merge task',category:'task',internalGate:'none',mutability:'task',resumeBehavior:'auto',
    description:'Cancel an obsolete or unwanted merge task owned by this conversation. Stops its worker, fences further writes and cleans up its isolated candidate. Use within the user-authorized scope when a task is superseded or no longer needed. Repeated cancellation is safe; completed merges are returned unchanged and never reverted. Does not delete source branches or user checkout files.',
    inputSchema:conversationGitCancelSchema,
    async execute(input){
      const {objectId}=conversationGitCancelSchema.parse(input.args);
      const {cancelConversationMergeWorker}=await import('./worker.js');
      const snapshot=await cancelConversationMergeWorker(input.sessionId,objectId);
      return {result:workerReceipt(snapshot),displaySummary:`合并任务：${snapshot.execution?.summary??snapshot.mr.status}`,artifacts:[]};
    },
  },
  {
    id:'git.merge.configure',label:'Configure merge verification',category:'task',internalGate:'none',mutability:'task',resumeBehavior:'auto',
    description:'Set grounded verification commands for a stopped or waiting merge task. Use after the worker reports missing verification, then call git.merge.resume on the same objectId to continue within the authorized merge scope.',
    inputSchema:conversationGitConfigureSchema,
    async execute(input){
      const {objectId,...args}=conversationGitConfigureSchema.parse(input.args);
      const snapshot=await conversationGitService.configureChecks(input.sessionId,objectId,{...args,requestId:`tool_${createHash('sha256').update(input.toolCallId).digest('hex')}`});
      return {result:compact(snapshot),displaySummary:'已更新验证配置，可调用 git.merge.resume 继续原合并任务。',artifacts:[]};
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
