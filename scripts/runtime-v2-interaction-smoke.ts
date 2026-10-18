import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../services/local-node/modules/agent-runtime/contracts.js';

const root = await mkdtemp(path.join(tmpdir(), 'synax-v2-interactions-'));
process.env.DATA_ROOT = root;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
const { RustRuntimeSupervisor } = await import('../services/local-node/infrastructure/runtime/rust-sidecar.js');
const { agentRuntimeStore: store } = await import('../services/local-node/modules/agent-runtime/session-store.js');
const { interactionService: forms } = await import('../services/local-node/modules/agent-runtime/interaction-service.js');
const { permissionPolicy } = await import('../services/local-node/modules/agent-runtime/permission-policy.js');
const { runtimeClient, patchRuntime } = await import('../services/local-node/modules/agent-runtime/sidecar/runtime-repository.js');
const { getPlanArtifact } = await import('../services/local-node/modules/agent-runtime/plan-artifact-store.js');
let supervisor = new RustRuntimeSupervisor({ dataRoot: root });
const now = new Date().toISOString();
try {
  await supervisor.start();
  const session: AgentSession = { id:'s',projectId:'p',parentSessionId:null,childSessionIds:[],nodeId:null,profileId:'synax',status:'completed',title:'forms',prompt:'ask',contextSnapshotId:null,
    thinkingMode:'standard',reasoningEffort:null,permissionRules:[],skillIds:[],mcpServerIds:[],createdAt:now,updatedAt:now,completedAt:null,resultSummary:null,blockedReason:null,activeRunId:null,pendingResumeToken:null,sessionMetadata:{mode:'goal'} };
  store.createSession(session); await store.flush();
  const run = {id:'r',sessionId:'s',status:'queued',startedAt:now,completedAt:null,triggerMessageId:null,currentStep:1,stopReason:null,model:null,metadata:{}};
  const before = await runtimeClient().snapshot('s');
  const accepted = await runtimeClient().admitRun({sessionId:'s',requestId:'admit',bodyHash:'ask',runId:'r',run,epoch:before.epoch,revision:before.revision});
  await runtimeClient().activateRun({sessionId:'s',run,epoch:accepted.epoch,revision:accepted.revision});
  await store.hydrateSession('s',true);
  const prepare = async (index: number, toolId: string) => {
    const stepId=`step-${index}`, toolCallId=`call-${index}`;
    store.appendRunStep({id:stepId,sessionId:'s',runId:'r',index,status:'running',model:null,startedAt:now,completedAt:null,finishReason:null,metadata:{}});
    store.appendToolCall({id:toolCallId,sessionId:'s',runId:'r',stepId,modelToolCallId:`model-${index}`,toolId,category:'task',mutability:'task',argsHash:'x',inputSummary:'ask',inputRef:{},outputSummary:null,outputRef:null,status:'running',permissionDecisionId:null,startedAt:now,endedAt:null,error:null});
    await store.flush();
    return {sessionId:'s',runId:'r',stepId,toolCallId};
  };
  const first = await forms.requestAuthoritative({...await prepare(1,'human.ask'),kind:'clarification',request:{title:'Scope',questions:[{id:'scope',type:'single_select',label:'Choose',required:true,options:[{value:'small',label:'Small'}]}]}});
  await assert.rejects(forms.replyAuthoritative('s',first.id,{revision:1,action:'submit',answers:{scope:'invalid'}}));
  assert.equal(forms.pending('s')?.id, first.id);
  await forms.replyAuthoritative('s',first.id,{revision:1,action:'submit',answers:{scope:'small'}});
  await supervisor.stop(); supervisor = new RustRuntimeSupervisor({dataRoot:root}); await supervisor.start();
  const consumed = await forms.consumeAuthoritative('s');
  assert.equal(consumed?.response?.answers?.scope, 'small');
  assert.equal(typeof consumed?.consumedAt, 'string');
  assert.equal(store.getToolCall('s','call-1').status,'completed');
  assert.equal(store.listRunParts('step-1').filter(part=>part.kind==='tool_result').length,1);
  assert.equal(await forms.consumeAuthoritative('s'),null);

  const proposal = await forms.requestAuthoritative({...await prepare(2,'plan.propose'),kind:'plan_approval',request:{plan:{title:'Implement',objective:'Persist forms',steps:[{id:'one',title:'First',description:'Implement'}],acceptanceCriteria:['Done']}}});
  await forms.replyAuthoritative('s',proposal.id,{revision:proposal.revision,action:'execute'});
  await forms.consumeAuthoritative('s');
  assert.equal(getPlanArtifact('s')?.status,'approved');
  assert.equal((store.getSession('s').sessionMetadata?.goal as {status:string}).status,'executing');

  store.appendPermission({id:'approval',sessionId:'s',runId:'r',stepId:'step-2',toolCallId:null,coarseCategory:'write',internalGate:'none',action:'ask',reason:'Approve',patterns:[],userReply:null,createdAt:now,resolvedAt:null,resumeToken:'resume',metadata:{}});
  await store.flush();
  permissionPolicy.reply('s','approval','once'); await store.flush();
  await store.hydrateSession('s',true);
  assert.equal(store.listPermissions('s')[0].userReply,'once');
  const control = await patchRuntime('s','read',{});
  assert.deepEqual(control.permissions,[]); assert.deepEqual(control.interactions,[]);
  const skipped = await forms.requestAuthoritative({...await prepare(3,'human.ask'),kind:'clarification',request:{title:'Optional',questions:[{id:'q',type:'text',label:'Input',required:false}]}});
  const skippedReply = {revision:1,action:'skip'};
  await forms.replyAuthoritative('s',skipped.id,skippedReply);
  await forms.replyAuthoritative('s',skipped.id,skippedReply);
  assert.match((await forms.consumeAuthoritative('s'))?.response?.message ?? '', /continue now/);
  const cancelled = await forms.requestAuthoritative({...await prepare(4,'human.ask'),kind:'clarification',request:{title:'Cancel',questions:[{id:'q',type:'text',label:'Input'}]}});
  forms.cancel('s'); await store.flush(); await store.hydrateSession('s',true);
  assert.equal(forms.list('s').find(value=>value.id===cancelled.id)?.status,'cancelled');
  assert.deepEqual((await patchRuntime('s','read',{})).interactions,[]);
  assert.equal(existsSync(path.join(root,'context.db')),false);
  console.log('Rust form/permission smoke passed: validation, reply, restart, consume once, tool evidence, plan execution, historical permissions; no SQLite file.');
} finally { await supervisor.stop(); await rm(root,{recursive:true,force:true}); }
