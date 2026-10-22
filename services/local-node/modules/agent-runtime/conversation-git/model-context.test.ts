import { describe,it,expect } from 'vitest';
import { buildLoopModelMessages } from '../loop-model-messages.js';
import type { AgentRuntimeStore } from '../session-store.js';
const reference={schema:'synax.git-merge',schemaVersion:1,objectId:'task',sessionId:'owner',projectId:'p',title:'Merge'};
function fixture(){return {listMessages:()=>[
 {id:'user',sessionId:'owner',role:'user',content:'第二个文件改用来源',metadata:{}},
 {id:'anchor',sessionId:'owner',role:'assistant',runId:null,stepId:null,content:'task',metadata:{source:'git_merge_task',gitMergeTask:reference,gitMergeState:{status:'conflicted',revision:3}}},
 {id:'receipt',sessionId:'owner',role:'assistant',runId:null,stepId:null,content:'auth.ts 已确认来源方案',metadata:{source:'git_merge_receipt',gitMergeTask:reference,operation:'saveFile',status:'succeeded'}},
 {id:'foreign',sessionId:'other',role:'assistant',content:'DO_NOT_INCLUDE',metadata:{source:'git_merge_receipt',gitMergeTask:{...reference,sessionId:'other'}}},
],listRuns:()=>[],listToolCalls:()=>[],listRunSteps:()=>[],listRunToolCalls:()=>[],listRunParts:()=>[]} as unknown as AgentRuntimeStore;}
describe('conversation Git actions in model context',()=>{
 it('retains standalone persisted objects and receipts through compaction',()=>{
  const messages=buildLoopModelMessages(fixture(),'owner',{resolveModelToolName:x=>x},{compactionSummary:'Earlier discussion',excludedStepIds:new Set(['old'])});
  const text=JSON.stringify(messages);
  expect(text).toContain('git.merge.read');expect(text).toContain('auth.ts 已确认来源方案');expect(text).toContain('objectId');expect(text).not.toContain('DO_NOT_INCLUDE');
  expect(messages.at(-1)?.content).toBe('第二个文件改用来源');
 });
});
