import { createHash } from 'node:crypto';
import type { RegisteredTool } from '../contracts.js';
import { conversationGitService } from './service.js';
import { conversationGitInputSchema, conversationGitProposalSchema, conversationGitReadSchema, conversationGitAnalyzeSchema } from './schemas.js';
import type { ConversationGitSnapshot } from './contracts.js';

function compact(snapshot: ConversationGitSnapshot) {
  const { mr, task, reference, stale, staleReason, files, proposals } = snapshot;
  return { reference, objectId:task.id, taskRevision:task.revision, mr:{id:mr.id,title:mr.title,status:mr.status,version:mr.version,target:mr.target,targetOid:mr.targetOid,steps:mr.steps,candidateOid:mr.candidateOid,candidateTree:mr.candidateTree,checks:mr.checks,checkResults:mr.checkResults.map(result=>({...result,output:result.output.slice(-12000)})),error:mr.error},stale,staleReason,files,proposals:proposals.map(({content,...proposal})=>({...proposal,characters:content.length})) };
}
export const conversationGitTools: RegisteredTool[] = [
  {
    id:'git.merge.create', label:'Create interactive merge task', category:'task', internalGate:'none', mutability:'task', resumeBehavior:'auto',
    description:'Create a persistent native Git merge task directly in this conversation. Use for local branch merge/conflict requests. Creates a draft only; the user starts isolated analysis, reviews decisions, runs explicit checks and confirms the final merge in the card. Never publishes or pushes automatically. Reuse git.merge.read for an existing task instead of creating duplicate cards.',
    progressiveDetails:'The source and target are real local branches in a registered session root. If more than one root is available, supply its exact rootId. Provide verification commands only when grounded in the repository. No command runs at creation. The user must approve updating a checked-out target via allowCheckedOutTarget. autoFinalize is not supported. Do not fake proposals, test counts or success.',
    inputSchema:conversationGitInputSchema,
    async execute(input){
      const args=conversationGitInputSchema.parse(input.args);
      const snapshot=await conversationGitService.create(input.sessionId,{...args,requestId:`tool_${createHash('sha256').update(input.toolCallId).digest('hex')}`},{runId:input.runId??undefined,stepId:input.stepId??undefined,toolCallId:input.toolCallId});
      return {result:compact(snapshot),displaySummary:`已创建对话内合并任务：${snapshot.mr.title}。请在任务卡开始分析。`,artifacts:[]};
    },
  },
  {
    id:'git.merge.analyze',label:'Analyze merge in an isolated worktree',category:'write',internalGate:'write',mutability:'write',resumeBehavior:'none',
    description:'Analyze a draft conversation merge task in an isolated Git worktree. Use after git.merge.create when the user requests merge/conflict analysis. This detects real conflicts and updates the existing card. It never runs checks, updates the target branch, or pushes. Pass the task and MR versions just returned by create/read. Only draft tasks are accepted.',
    inputSchema:conversationGitAnalyzeSchema,
    async execute(input){
      const {objectId,...versions}=conversationGitAnalyzeSchema.parse(input.args);
      const snapshot=await conversationGitService.action(input.sessionId,objectId,{...versions,action:'prepare',requestId:`tool_${createHash('sha256').update(input.toolCallId).digest('hex')}`});
      return {result:compact(snapshot),displaySummary:`隔离分析完成：${snapshot.files.filter(file=>file.conflicted).length} 个冲突文件。`,artifacts:[]};
    },
  },
  {
    id:'git.merge.read',label:'Inspect conversation merge task',category:'read',internalGate:'none',mutability:'read',resumeBehavior:'auto',
    description:'Read persistent Git merge tasks owned by this conversation. Omit objectId to list tasks; provide objectId for status/files/proposals and fileId for base/target/source/result and current revision. Long files are bounded; use side/offset/limit to page exact content before proposing a whole-file replacement. Use before explaining or proposing changes to the same inline card. Does not execute Git writes.',
    inputSchema:conversationGitReadSchema,
    async execute(input){
      const args=conversationGitReadSchema.parse(input.args);
      let result:unknown;
      if(!args.objectId)result=(await conversationGitService.list(input.sessionId)).slice(0,20).map(compact);
      else if(args.fileId){
        const file=await conversationGitService.file(input.sessionId,args.objectId,args.fileId);
        if(args.side){const content=file[args.side];result={fileId:file.id,path:file.path,revision:file.revision,side:args.side,offset:args.offset,content:content.slice(args.offset,args.offset+args.limit),totalCharacters:content.length,truncated:args.offset+args.limit<content.length};}
        else {const {resolutionState:_state,...summary}=file;result={...summary,base:file.base.slice(0,args.limit),target:file.target.slice(0,args.limit),source:file.source.slice(0,args.limit),result:file.result.slice(0,args.limit),truncated:[file.base,file.target,file.source,file.result].some(value=>value.length>args.limit),limit:args.limit};}
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
